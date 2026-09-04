// Cardinal Calcutta war-room server.
// Single process: serves the built app, a JSON API, and a WebSocket that pushes the full
// computed view (auction state + live repricing + season earnings) on every change.
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TEAMS, TEAM_IDS } from "../engine/teams.js";
import { valuate, VALUATION_VERSION } from "../engine/sim.js";
import { fetchAndCache } from "../engine/fetch-schedule.js";
import { loadProfiles, resolveProfile } from "../engine/payouts.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
// Config files are repo-managed: every deploy refreshes the volume's copies so updated lines
// and payout weights actually reach production. Only the user's chosen `active` profile persists.
if (DATA_DIR !== path.join(ROOT, "data")) {
  for (const f of ["win-totals-2026.json", "market-odds-2026.json"]) {
    const src = path.join(ROOT, "data", f), dst = path.join(DATA_DIR, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  const pSrc = path.join(ROOT, "data", "payout-profiles-2026.json"), pDst = path.join(DATA_DIR, "payout-profiles-2026.json");
  if (fs.existsSync(pSrc)) {
    const fresh = JSON.parse(fs.readFileSync(pSrc, "utf8"));
    try {
      const prev = JSON.parse(fs.readFileSync(pDst, "utf8"));
      if (prev.active && fresh.profiles[prev.active]) fresh.active = prev.active;
    } catch {}
    fs.writeFileSync(pDst, JSON.stringify(fresh, null, 1));
  }
}
const DATA = p => path.join(DATA_DIR, p);
const PORT = process.env.PORT || 4600;

// ---------- persistent state ----------
const DEFAULT_STATE = {
  config: {
    groups: [
      { id: "g1", name: "Us (David/Joon/Gunther)", budget: 7000 },
      { id: "g2", name: "Group 2", budget: 7000 },
      { id: "g3", name: "Group 3", budget: 7000 },
      { id: "g4", name: "Group 4", budget: 7000 },
      { id: "g5", name: "Group 5", budget: 7000 },
      { id: "g6", name: "Group 6", budget: 7000 }
    ],
    ourGroupId: "g1",
    priorPot: 40000,
    targetMargin: 0.85
  },
  auction: { phase: "setup", onBlock: null, paused: false, bids: [], sales: {}, skipped: [] },
  trades: []
};

let state = fs.existsSync(DATA("state.json"))
  ? JSON.parse(fs.readFileSync(DATA("state.json"), "utf8"))
  : structuredClone(DEFAULT_STATE);
// Migrate pre-dynamic-draft state files (ordered pointer -> onBlock).
if (!("onBlock" in state.auction)) {
  state.auction.onBlock = state.auction.phase === "live" ? state.auction.order?.[state.auction.current] ?? null : null;
  delete state.auction.order;
  delete state.auction.current;
}
state.auction.skipped ??= [];
state.auction.bids ??= [];
state.auction.sales ??= {};
state.auction.origSaleTs ??= {};
state.auction.paused ??= false;
state.seasonStarted ??= state.auction.phase === "done";
let undoStack = [];

let schedule = fs.existsSync(DATA("schedule-2026.json"))
  ? JSON.parse(fs.readFileSync(DATA("schedule-2026.json"), "utf8"))
  : null;
let valuation = fs.existsSync(DATA("valuation.json"))
  ? JSON.parse(fs.readFileSync(DATA("valuation.json"), "utf8"))
  : null;

let profiles = loadProfiles(DATA_DIR);

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DATA("state.json"), JSON.stringify(state, null, 1)), 250);
}

// ---------- derived: earnings ledger from real results ----------
function payoutEvents() {
  if (!schedule) return [];
  const p = resolveProfile(profiles);
  const events = [];
  const push = (type, team, ts, credit) => { if (credit > 0) events.push({ type, team, ts, credit }); };
  const finals = schedule.games.filter(g => g.final && g.homeScore != null);
  const firstPlayoff = {}; // team -> earliest playoff week seen
  for (const g of finals) {
    const winner = g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : null;
    if (g.seasontype === 2) {
      if (winner) push("regWin", winner, g.date, p.regWin);
    } else if (g.seasontype === 3) {
      for (const t of [g.home, g.away]) {
        if (!(t in firstPlayoff) || g.week < firstPlayoff[t].week) firstPlayoff[t] = { week: g.week, ts: g.date };
      }
      if (g.week === 1) {
        push("divTitle", g.home, g.date, p.divTitle); // WC hosts are division winners (seeds 2-4)
        if (winner) { push("wcWin", winner, g.date, p.wcWin); push("reachDiv", winner, g.date, p.reachDiv); }
      } else if (g.week === 2 && winner) push("divWin", winner, g.date, p.divWin);
      else if (g.week === 3 && winner) push("confWin", winner, g.date, p.confWin);
      else if (g.week === 5 && winner) push("sbWin", winner, g.date, p.sbWin);
    }
  }
  for (const [team, info] of Object.entries(firstPlayoff)) {
    push("berth", team, info.ts, p.berth);
    // Teams whose first playoff game is the divisional round had the bye = #1 seed = a division winner.
    if (info.week === 2) {
      push("oneSeed", team, info.ts, p.oneSeed);
      push("divTitle", team, info.ts, p.divTitle);
      push("reachDiv", team, info.ts, p.reachDiv);
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

function ownershipAt(team, ts) {
  const sale = state.auction.sales[team];
  if (!sale || sale.ts > ts) return {};
  const own = { [sale.group]: 100 };
  for (const tr of state.trades.filter(t => t.team === team && t.ts <= ts).sort((a, b) => a.ts.localeCompare(b.ts))) {
    own[tr.from] = (own[tr.from] || 0) - tr.pct;
    own[tr.to] = (own[tr.to] || 0) + tr.pct;
  }
  return own;
}

// ---------- derived: live auction repricing ----------
function repricing() {
  const shares = Object.fromEntries(TEAM_IDS.map(t => [t, valuation?.teams?.[t]?.share ?? 100 / 32]));
  const sales = Object.values(state.auction.sales);
  const spent = sales.reduce((s, x) => s + x.amount, 0);
  const soldShare = Object.keys(state.auction.sales).reduce((s, t) => s + shares[t], 0);
  const totalShare = TEAM_IDS.reduce((s, t) => s + shares[t], 0);
  const priorRate = state.config.priorPot / totalShare;
  const observedRate = soldShare > 0 ? spent / soldShare : priorRate;
  const alpha = Math.min(1, soldShare / 25); // trust the room once ~25 share-points have sold
  const rate = alpha * observedRate + (1 - alpha) * priorRate;
  // The pot can never exceed what the groups are allowed to commit in total.
  const maxPot = state.config.groups.reduce((s, g) => s + (Number(g.budget) || 0), 0) || Infinity;
  const potEstimate = Math.min(spent + (totalShare - soldShare) * rate, maxPot);
  const heat = observedRate / priorRate;
  const fair = Object.fromEntries(TEAM_IDS.map(t => [t, (shares[t] * potEstimate) / totalShare]));
  return { potEstimate, spent, soldShare, heat: soldShare > 0 ? heat : 1, rate, fair };
}

function groupSummaries(events, pot) {
  const out = {};
  for (const g of state.config.groups) {
    out[g.id] = { spent: 0, earnedShare: 0, tradeCash: 0, teams: [] };
  }
  for (const [team, sale] of Object.entries(state.auction.sales)) {
    if (out[sale.group]) {
      out[sale.group].spent += sale.amount;
      out[sale.group].teams.push(team);
    }
  }
  for (const tr of state.trades) {
    if (out[tr.from]) out[tr.from].tradeCash += tr.cash;
    if (out[tr.to]) out[tr.to].tradeCash -= tr.cash;
  }
  const earnedByTeam = {};
  for (const ev of events) {
    const own = ownershipAt(ev.team, ev.ts);
    earnedByTeam[ev.team] = (earnedByTeam[ev.team] || 0) + ev.credit;
    for (const [gid, pct] of Object.entries(own)) {
      if (out[gid]) out[gid].earnedShare += (ev.credit * pct) / 100;
    }
  }
  for (const g of state.config.groups) {
    const s = out[g.id];
    s.remaining = g.budget - s.spent;
    s.earnedDollars = (s.earnedShare / 100) * pot;
    s.net = s.earnedDollars - s.spent + s.tradeCash;
  }
  return { groups: out, earnedByTeam };
}


// ---------- derived: week-by-week season view ----------
const WEEK_LABEL = (st, wk) => (st === 2 ? `Week ${wk}` : { 1: "Wild Card", 2: "Divisional", 3: "Conf. Champ.", 5: "Super Bowl" }[wk] || `Playoffs ${wk}`);
function seasonSummary(events, pot) {
  if (!schedule) return null;
  const games = [...schedule.games].sort((a, b) => a.date.localeCompare(b.date));
  const weeksMap = new Map();
  for (const g of games) {
    const key = `${g.seasontype}-${g.week}`;
    if (!weeksMap.has(key)) weeksMap.set(key, { key, seasontype: g.seasontype, week: g.week, label: WEEK_LABEL(g.seasontype, g.week), games: [], start: g.date });
    const winner = g.final && g.homeScore != null ? (g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : null) : null;
    // Credits come straight from the payout ledger for this game's date/teams — never a parallel formula.
    const credits = {};
    for (const ev of events) if (ev.ts === g.date && (ev.team === g.home || ev.team === g.away)) credits[ev.team] = (credits[ev.team] || 0) + ev.credit;
    weeksMap.get(key).games.push({
      id: g.id, date: g.date, home: g.home, away: g.away, homeScore: g.homeScore, awayScore: g.awayScore,
      final: !!g.final, state: g.state || (g.final ? "post" : "pre"), timeValid: g.timeValid !== false, winner,
      credits: Object.entries(credits).map(([team, credit]) => ({ team, credit, owners: ownershipAt(team, g.date) })),
      homeOwners: ownershipAt(g.home, g.date), awayOwners: ownershipAt(g.away, g.date)
    });
  }
  const weeks = [...weeksMap.values()];
  // current week = first week with an unfinished game (or the last week)
  const pending = g => !g.final && g.state !== "post"; // canceled games are not pending forever
  const cur = weeks.find(w => w.games.some(pending)) || weeks[weeks.length - 1];
  // per-group earnings by week, from the payout events (dated by game)
  const byGroupWeek = {};
  for (const ev of events) {
    const w = weeks.find(w => w.games.some(g => g.date === ev.ts && (g.home === ev.team || g.away === ev.team)));
    const key = w ? w.key : "other";
    for (const [gid, pct] of Object.entries(ownershipAt(ev.team, ev.ts))) {
      (byGroupWeek[gid] ??= {});
      byGroupWeek[gid][key] = (byGroupWeek[gid][key] || 0) + (ev.credit * pct) / 100 / 100 * pot;
    }
  }
  // records + banked per team
  const teamRecord = Object.fromEntries(TEAM_IDS.map(t => [t, { w: 0, l: 0, t: 0 }]));
  for (const g of games) {
    if (!(g.final && g.seasontype === 2 && g.homeScore != null)) continue;
    if (g.homeScore > g.awayScore) { teamRecord[g.home].w++; teamRecord[g.away].l++; }
    else if (g.awayScore > g.homeScore) { teamRecord[g.away].w++; teamRecord[g.home].l++; }
    else { teamRecord[g.home].t++; teamRecord[g.away].t++; }
  }
  return { currentWeek: cur?.key || null, weeks, byGroupWeek, teamRecord };
}

// Projected season-end earnings: banked (historical ownership) + future share × current ownership × pot.
function projections(gs, pot) {
  const now = new Date().toISOString();
  const out = {};
  for (const g of state.config.groups) out[g.id] = { banked: gs.groups[g.id].earnedDollars, future: 0 };
  const perTeam = {};
  for (const t of Object.keys(state.auction.sales)) {
    const total = valuation?.teams?.[t]?.share ?? 0;
    const future = Math.max(0, total - (gs.earnedByTeam[t] || 0));
    perTeam[t] = { totalShare: total, bankedShare: gs.earnedByTeam[t] || 0, futureShare: future };
    for (const [gid, pct] of Object.entries(ownershipAt(t, now))) {
      if (out[gid]) out[gid].future += (future / 100) * pot * (pct / 100);
    }
  }
  for (const g of state.config.groups) {
    const o = out[g.id]; const spent = gs.groups[g.id].spent; const cash = gs.groups[g.id].tradeCash;
    o.projectedEarned = o.banked + o.future;
    o.projectedNet = o.projectedEarned - spent + cash;
  }
  const currentOwners = Object.fromEntries(Object.keys(state.auction.sales).map(t => [t, ownershipAt(t, now)]));
  return { groups: out, teams: perTeam, currentOwners };
}

function view() {
  const rp = repricing();
  const events = payoutEvents();
  const finalPot = rp.spent; // once auction done, actual pot = total sold
  const potForSettlement = (state.seasonStarted || state.auction.phase === "done") ? finalPot : rp.potEstimate;
  // Every dollar figure on screen derives from the SAME pot, or the tables disagree.
  const gs = groupSummaries(events, potForSettlement);
  const season = seasonSummary(events, potForSettlement);
  const proj = projections(gs, potForSettlement);
  return {
    season,
    projections: proj,
    seasonStarted: !!state.seasonStarted,
    state,
    teams: TEAMS,
    valuation: valuation ? {
      computedAt: valuation.computedAt,
      gamesPlayed: valuation.gamesPlayed,
      teams: valuation.teams,
      matchups: valuation.matchups || null,
      marketWeight: valuation.marketWeight ?? 0,
      profile: valuation.profile || null
    } : null,
    repricing: rp,
    potForSettlement,
    events,
    summaries: gs.groups,
    earnedByTeam: gs.earnedByTeam,
    scheduleFetchedAt: schedule?.fetchedAt || null,
    undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label ?? null : null,
    scoringProfile: { active: profiles.active, label: profiles.profiles[profiles.active]?.label || profiles.active, options: Object.fromEntries(Object.entries(profiles.profiles).map(([k, v]) => [k, v.label])) }
  };
}

// ---------- websocket ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast() {
  const payload = JSON.stringify({ type: "view", data: view() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
}
wss.on("connection", ws => ws.send(JSON.stringify({ type: "view", data: view() })));

// ---------- background: auto score sync + revaluation ----------
let revaluing = false;
async function syncScores({ force = false } = {}) {
  try {
    const before = schedule ? schedule.games.filter(g => g.final).length : -1;
    schedule = await fetchAndCache();
    const after = schedule.games.filter(g => g.final).length;
    // Recompute when the code version OR any valuation input (lines, odds, active profile) changed.
    const inputsHash = ["win-totals-2026.json", "market-odds-2026.json", "payout-profiles-2026.json"]
      .map(f => { try { return fs.readFileSync(DATA(f), "utf8"); } catch { return ""; } })
      .reduce((h, s) => { for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }, 7);
    const stale = !valuation || valuation.version !== VALUATION_VERSION || valuation.inputsHash !== inputsHash;
    if ((after !== before || force || stale) && !revaluing) {
      revaluing = true;
      try {
        const winTotals = JSON.parse(fs.readFileSync(DATA("win-totals-2026.json"), "utf8"));
        let marketOdds = null;
        try { marketOdds = JSON.parse(fs.readFileSync(DATA("market-odds-2026.json"), "utf8")); } catch {}
        valuation = valuate(schedule.games, winTotals, 10000, marketOdds, resolveProfile(profiles));
        valuation.inputsHash = inputsHash;
        fs.writeFileSync(DATA("valuation.json"), JSON.stringify(valuation, null, 1));
      } finally {
        revaluing = false;
      }
    }
    broadcast();
    return { ok: true, finals: after };
  } catch (e) {
    console.error("sync failed:", e.message);
    return { ok: false, error: e.message };
  }
}
setInterval(() => syncScores(), 60 * 60 * 1000); // hourly during the season
syncScores(); // on boot: fresh schedule + valuation, zero manual steps

// ---------- actions ----------
const MIN_OPEN = 50;
const nextIncrement = amount => (amount < 500 ? 25 : 50);

function snapshot(label) {
  undoStack.push({ label, ...structuredClone({ auction: state.auction, trades: state.trades }) });
  if (undoStack.length > 100) undoStack.shift();
}

const bidsFor = team => state.auction.bids.filter(b => b.team === team);
// The top bid is the HIGHEST, not the last-appended — concurrent devices can log out of order.
const topBidFor = team => bidsFor(team).reduce((a, b) => (!a || b.amount >= a.amount ? b : a), null);
const groupById = id => state.config.groups.find(g => g.id === id);
const groupSpent = id => Object.values(state.auction.sales).reduce((s, x) => s + (x.group === id ? x.amount : 0), 0);

const actions = {
  setGroups({ groups }) {
    state.config.groups = groups.map((g, i) => ({
      id: g.id || `g${i + 1}`,
      name: String(g.name || `Group ${i + 1}`).slice(0, 60),
      budget: Number(g.budget) || 7000,
      aliases: String(g.aliases || "").slice(0, 200)
    }));
  },
  setOurGroup({ groupId }) { state.config.ourGroupId = groupId; },
  setPriorPot({ pot }) { state.config.priorPot = Math.max(1000, Number(pot) || 40000); },
  setTargetMargin({ margin }) { state.config.targetMargin = Math.min(1.5, Math.max(0.3, Number(margin) || 0.85)); },
  startAuction() {
    snapshot("draft start");
    state.auction.phase = "live";
    state.auction.onBlock = null;
    state.auction.paused = false;
  },
  setPaused({ paused }) {
    state.auction.paused = !!paused;
  },
  setScoringProfile({ profile }) {
    if (!profiles.profiles[profile]) return { error: "Unknown scoring profile." };
    profiles.active = profile;
    fs.writeFileSync(DATA("payout-profiles-2026.json"), JSON.stringify(profiles, null, 1));
    syncScores({ force: true }); // revalue under the new rules (async; broadcasts when done)
  },
  blockTeam({ team }) {
    if (state.auction.paused) return { error: "Draft is paused — resume first." };
    if (!TEAM_IDS.includes(team)) return { error: "Unknown team." };
    if (state.auction.sales[team]) return { error: "Already sold — reopen it instead." };
    if (state.auction.onBlock === team) return {}; // already up — no-op, don't purge live bids
    snapshot(`${team} on the block`);
    state.auction.skipped = state.auction.skipped.filter(t => t !== team);
    // Fresh block = fresh bidding: dead bids from an earlier skip/clear must not resurface.
    state.auction.bids = state.auction.bids.filter(b => b.team !== team);
    state.auction.onBlock = team;
    state.auction.phase = "live";
  },
  clearBlock() {
    if (state.auction.paused) return { error: "Draft is paused — resume first." };
    const team = state.auction.onBlock;
    snapshot(team ? `clearing ${team}` : "clearing block");
    if (team) state.auction.bids = state.auction.bids.filter(b => b.team !== team);
    state.auction.onBlock = null;
  },
  logBid({ team, group, amount }) {
    if (state.auction.paused) return { error: "Draft is paused — resume first." };
    const cur = state.auction.onBlock;
    if (!cur) return { error: "No team on the block." };
    if (team && team !== cur) return { error: `Block changed to ${cur} — bid not logged.` };
    const g = groupById(group);
    if (!g) return { error: "Unknown group." };
    const top = topBidFor(cur);
    const amt = amount != null ? Number(amount) : top ? top.amount + nextIncrement(top.amount) : MIN_OPEN;
    if (!(amt >= MIN_OPEN)) return { error: `Minimum bid is $${MIN_OPEN}.` };
    if (top && amt <= top.amount) return { error: `Top bid is already $${top.amount} — a raise must beat it.` };
    const remaining = g.budget - groupSpent(g.id);
    if (amt > remaining) return { error: `${g.name} only has $${remaining} left.` };
    snapshot(`$${amt} bid on ${cur}`);
    state.auction.bids.push({ team: cur, group: g.id, amount: amt, ts: new Date().toISOString() });
  },
  sold({ team, group, amount }) {
    if (state.auction.paused) return { error: "Draft is paused — resume first." };
    const cur = state.auction.onBlock;
    if (!cur) return { error: "No team on the block." };
    if (team && team !== cur) return { error: `Block changed to ${cur} — sale not recorded.` };
    const top = topBidFor(cur);
    const g = groupById(group || top?.group);
    const amt = amount != null ? Number(amount) : top?.amount;
    if (!g || !amt) return { error: "No bid to close — log a bid or pass group+amount." };
    const remaining = g.budget - groupSpent(g.id);
    if (amt > remaining) return { error: `${g.name} only has $${remaining} left.` };
    snapshot(`sale of ${cur} ($${amt})`);
    // A reopened team keeps its ORIGINAL sale timestamp so already-banked wins stay credited.
    const ts = state.auction.origSaleTs?.[cur] ?? new Date().toISOString();
    if (state.auction.origSaleTs) delete state.auction.origSaleTs[cur];
    state.auction.sales[cur] = { group: g.id, amount: Number(amt), ts };
    state.auction.onBlock = null;
    if (Object.keys(state.auction.sales).length >= TEAM_IDS.length) { state.auction.phase = "done"; state.seasonStarted = true; }
  },
  skipTeam() {
    if (state.auction.paused) return { error: "Draft is paused — resume first." };
    const team = state.auction.onBlock;
    if (!team) return { error: "No team on the block." };
    snapshot(`skip of ${team}`);
    if (!state.auction.skipped.includes(team)) state.auction.skipped.push(team);
    state.auction.bids = state.auction.bids.filter(b => b.team !== team);
    state.auction.onBlock = null;
  },
  editSale({ team, amount, group }) {
    const s = state.auction.sales[team];
    if (!s) return { error: "Team is not sold." };
    const gid = group || s.group;
    const g = groupById(gid);
    if (!g) return { error: "Unknown group." };
    const newAmt = amount != null && Number(amount) > 0 ? Number(amount) : s.amount;
    // Budget check excludes this sale's current charge against the target group.
    const spentExcl = groupSpent(gid) - (s.group === gid ? s.amount : 0);
    if (newAmt > g.budget - spentExcl) return { error: `${g.name} only has $${g.budget - spentExcl} left.` };
    snapshot(`edit of ${team} sale`);
    s.amount = newAmt;
    s.group = gid;
  },
  editLastBid({ amount, group }) {
    const cur = state.auction.onBlock;
    if (!cur) return { error: "No team on the block." };
    const top = topBidFor(cur);
    if (!top) return { error: "No bid to edit." };
    if (group && !groupById(group)) return { error: "Unknown group." };
    snapshot(`edit of top bid on ${cur}`);
    if (amount != null && Number(amount) > 0) top.amount = Number(amount);
    if (group) top.group = group;
  },
  reopenTeam({ team }) {
    if (state.seasonStarted) return { error: "Season has started — fix price/owner with ✎ instead of reopening." };
    if (state.auction.paused) return { error: "Draft is paused — resume first. (Price fixes via ✎ still work.)" };
    const s = state.auction.sales[team];
    if (!s) return { error: "Team is not sold." };
    snapshot(`reopen of ${team}`);
    (state.auction.origSaleTs ??= {})[team] = s.ts;
    delete state.auction.sales[team];
    state.auction.skipped = state.auction.skipped.filter(t => t !== team);
    state.auction.bids = state.auction.bids.filter(b => b.team !== team);
    state.auction.onBlock = team;
    state.auction.phase = "live";
  },
  undo() {
    const prev = undoStack.pop();
    if (!prev) return { error: "Nothing to undo." };
    // Pause is LIVE state, not history — undoing a bid must never silently resume/re-pause the room.
    const livePaused = state.auction.paused;
    state.auction = prev.auction;
    state.auction.paused = livePaused;
    state.trades = prev.trades;
  },
  addTrade({ team, from, to, pct, cash }) {
    if (!state.auction.sales[team]) return { error: "That team was never sold." };
    if (!from || !to || from === to) return { error: "Seller and buyer must be two different groups." };
    if (!groupById(from) || !groupById(to)) return { error: "Unknown group." };
    const stakePct = Math.round(Number(pct) * 10) / 10;
    const now = new Date().toISOString(); // server time only — trades can't be backdated
    const stake = ownershipAt(team, now)[from] || 0;
    if (!(stakePct > 0) || stakePct > stake + 1e-9) return { error: `${groupById(from).name} owns ${stake}% of ${team} — can't sell ${stakePct}%.` };
    if (!(Number(cash) >= 0)) return { error: "Cash must be zero or positive." };
    const live = (schedule?.games || []).some(g => g.state === "in" && (g.home === team || g.away === team));
    if (live) return { error: `${team} is mid-game — record the trade after the final (wins bank to the owner at kickoff).` };
    const deadline = (schedule?.games || []).some(g => g.seasontype === 3 && g.week === 3 && TEAM_IDS.includes(g.home) && TEAM_IDS.includes(g.away));
    if (deadline) return { error: "Trade deadline passed — conference championship matchups are set." };
    snapshot(`trade ${stakePct}% ${team}`);
    state.trades.push({ id: `t${Date.now()}`, team, from, to, pct: stakePct, cash: Number(cash), ts: now });
  },
  deleteTrade({ id }) {
    snapshot();
    state.trades = state.trades.filter(t => t.id !== id);
  },
  resetAuction() {
    snapshot("full reset");
    state.auction = { phase: "setup", onBlock: null, bids: [], sales: {}, skipped: [], origSaleTs: {} };
    state.trades = [];
  }
};

app.use(express.json());
app.get("/api/view", (_req, res) => res.json(view()));
app.post("/api/action", (req, res) => {
  const { type, ...payload } = req.body || {};
  const fn = actions[type];
  if (!fn) return res.status(400).json({ error: `Unknown action: ${type}` });
  const result = fn(payload) || {};
  persist();
  broadcast();
  res.json({ ok: !result.error, ...result });
});
app.post("/api/sync", async (_req, res) => res.json(await syncScores({ force: !!_req.body?.force })));

// ---------- transcript log: every finalized speech segment, persisted to disk ----------
const TDIR = DATA("transcripts");
fs.mkdirSync(TDIR, { recursive: true });
const tFile = () => path.join(TDIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
app.post("/api/transcript", (req, res) => {
  const line = {
    ts: new Date().toISOString(),
    text: String(req.body?.text || "").slice(0, 500),
    amounts: Array.isArray(req.body?.amounts) ? req.body.amounts.slice(0, 5) : [],
    group: req.body?.group || null,
    team: state.auction.onBlock || null
  };
  if (!line.text) return res.status(400).json({ error: "empty" });
  fs.appendFileSync(tFile(), JSON.stringify(line) + "\n");
  const payload = JSON.stringify({ type: "transcript", line });
  for (const c of wss.clients) if (c.readyState === 1) c.send(payload);
  res.json({ ok: true });
});
app.get("/api/transcript", (_req, res) => {
  const lines = fs.existsSync(tFile())
    ? fs.readFileSync(tFile(), "utf8").trim().split("\n").slice(-80).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  res.json({ lines });
});

app.use(express.static(path.join(ROOT, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "dist", "index.html")));

server.listen(PORT, () => console.log(`Cardinal Calcutta war room on http://localhost:${PORT}`));
