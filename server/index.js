// Cardinal Calcutta war-room server.
// Single process: serves the built app, a JSON API, and a WebSocket that pushes the full
// computed view (auction state + live repricing + season earnings) on every change.
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { TEAMS, TEAM_IDS } from "../engine/teams.js";
import { valuate, VALUATION_VERSION, winProb, HFA } from "../engine/sim.js";
import { fetchStandings } from "../engine/fetch-standings.js";
import { fetchAndCache } from "../engine/fetch-schedule.js";
import { loadProfiles, resolveProfile } from "../engine/payouts.js";
import { fetchOdds } from "../engine/fetch-odds.js";

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

// ---------- admin passcode + sessions ----------
// The site is public to the whole league; edits (draft fixes, trades, setup) and our private
// tools (trade finder, transcripts) need the passcode. Only a salted scrypt hash is stored here.
// The slow scrypt check runs ONLY at sign-in (rate-limited, async, one at a time); after that a
// device carries an HMAC-signed session token that verifies in microseconds.
const ADMIN_HASH = { salt: "1baf7745fcfdd42c1462fabfb7674839", dk: "7a6a0b2725d23b04077db682448d82b87b41360b1665b6a6ef285a7b856a1613" };
const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, "session-secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch {}
  const sec = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(f, sec, { mode: 0o600 }); } catch {}
  return sec;
})();
const SESSION_DAYS = 150;
const b64u = b => Buffer.from(b).toString("base64url");
function issueToken() {
  const body = b64u(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400e3 }));
  return body + "." + crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
}
function verifyToken(tok) {
  if (typeof tok !== "string" || tok.length > 300 || !/^[\w-]+\.[\w-]+$/.test(tok)) return false;
  const [body, sig] = tok.split(".");
  const want = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now(); } catch { return false; }
}
const isAdmin = req => verifyToken(req.get("x-admin-key"));
let scryptBusy = false;
const authTries = new Map(); // ip -> recent attempt timestamps
function checkPasscode(key) {
  return new Promise(resolve => {
    if (!key || typeof key !== "string" || key.length > 200) return resolve(false);
    if (process.env.ADMIN_KEY && key.length === process.env.ADMIN_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(process.env.ADMIN_KEY))) return resolve(true);
    crypto.scrypt(key, Buffer.from(ADMIN_HASH.salt, "hex"), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, dk) =>
      resolve(!err && crypto.timingSafeEqual(dk, Buffer.from(ADMIN_HASH.dk, "hex"))));
  });
}

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
// Meme photos live on the Railway volume, never in the public repo.
const MEME_IDS = ["buf", "fuller", "mike", "butt", "war"];
const memeFile = id => DATA(`meme-${id}.img`), memeMetaFile = id => DATA(`meme-${id}.json`);
const memes = Object.fromEntries(MEME_IDS.map(id => { try { return [id, JSON.parse(fs.readFileSync(memeMetaFile(id), "utf8"))]; } catch { return [id, null]; } }));
let nflStandings = (() => { try { return JSON.parse(fs.readFileSync(DATA("standings-2026.json"), "utf8")); } catch { return null; } })();

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
      id: g.id, date: g.date, seasontype: g.seasontype, week: g.week, home: g.home, away: g.away, homeScore: g.homeScore, awayScore: g.awayScore,
      final: !!g.final, state: g.state || (g.final ? "post" : "pre"), timeValid: g.timeValid !== false, winner,
      shortDetail: g.shortDetail || null, neutral: !!g.neutral,
      pHome: !g.final && valuation?.ratings?.[g.home] != null ? winProb(valuation.ratings[g.home], valuation.ratings[g.away], g.neutral ? 0 : HFA) : null,
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


// ---------- market odds: static snapshot + live ESPN futures overlay ----------
function readLive() {
  try { return JSON.parse(fs.readFileSync(DATA("market-odds-live.json"), "utf8")); } catch { return null; }
}
function loadMarketOdds() {
  const live = readLive();
  const out = {};
  if (live) {
    // Once a live snapshot exists it is ALWAYS fresher than the preseason file: never fall back.
    // Teams absent from a board reach the sim fallback in marketProbs (no static price sneaks in).
    for (const t of TEAM_IDS) {
      out[t] = {};
      if (live.sb?.[t] != null) out[t].sb = live.sb[t];
      if (live.division?.[t] != null) out[t].division = live.division[t];
      if (live.conf?.[t] != null) out[t].conf = live.conf[t];
    }
    return out;
  }
  let base = {};
  try { base = JSON.parse(fs.readFileSync(DATA("market-odds-2026.json"), "utf8")); } catch {}
  for (const t of TEAM_IDS) out[t] = { ...(base[t] || {}) };
  return out;
}
let oddsMeta = { fetchedAt: null, provider: null, error: null, ageDays: null };
function updateOddsMeta(error = null) {
  const l = readLive();
  const fetchedAt = l?.fetchedAt || null;
  oddsMeta = {
    fetchedAt, provider: l?.provider || null, providers: l?.providers || null, missing: l?.missing || null,
    error, ageDays: fetchedAt ? Math.floor((Date.now() - Date.parse(fetchedAt)) / 86400e3) : null
  };
}
updateOddsMeta();
let lastOddsRefresh = 0;
async function refreshOdds({ minGapMs = 0 } = {}) {
  if (Date.now() - lastOddsRefresh < minGapMs) return;
  lastOddsRefresh = Date.now();
  try {
    const prev = readLive();
    const live = await fetchOdds(prev);
    const same = prev && JSON.stringify([prev.sb, prev.conf, prev.division]) === JSON.stringify([live.sb, live.conf, live.division]);
    fs.writeFileSync(DATA("market-odds-live.json"), JSON.stringify(live, null, 1));
    updateOddsMeta(null);
    if (!same) await syncScores(); // effective inputs changed -> revalue (unchanged odds don't re-roll the sim)
    else broadcast();
  } catch (e) {
    updateOddsMeta(e.message);
    console.error("odds refresh failed:", e.message);
  }
}

// ---------- trade finder: where our model and the public's view disagree ----------
function tradeFinder(gs, pot) {
  if (!valuation?.teams) return { buy: [], sell: [], all: [], stale: true, reason: "no valuation yet" };
  const now = new Date().toISOString();
  const ours = state.config.ourGroupId;
  // Teams that lost a final playoff game have no future (interim until the playoff-aware engine lands).
  const eliminated = new Set();
  for (const g of schedule?.games || []) {
    if (g.seasontype === 3 && g.final && g.homeScore != null && g.homeScore !== g.awayScore) eliminated.add(g.homeScore > g.awayScore ? g.away : g.home);
  }
  // Market snapshot must be at least as new as the newest final, or "market value" is just lag.
  const newestFinal = (schedule?.games || []).filter(g => g.final).map(g => g.date).sort().pop() || null;
  const staleOdds = !!newestFinal && (!oddsMeta.fetchedAt || oddsMeta.fetchedAt < newestFinal);
  const rows = [];
  for (const t of Object.keys(state.auction.sales)) {
    const v = valuation.teams[t]; if (!v) continue;
    const banked = gs.earnedByTeam[t] || 0;
    const dead = eliminated.has(t);
    const modelFuture = dead ? 0 : Math.max(0, (v.shareModel ?? v.share ?? 0) - banked) / 100 * pot;
    const marketFuture = dead ? 0 : Math.max(0, (v.shareMarket ?? v.share ?? 0) - banked) / 100 * pot;
    const owners = ownershipAt(t, now);
    const ourStake = owners[ours] || 0;
    rows.push({ team: t, owners, ourStake, banked$: banked / 100 * pot, modelFuture, marketFuture, edge: modelFuture - marketFuture,
      edgePct: marketFuture > 0 ? (modelFuture - marketFuture) / marketFuture : 0, eliminated: dead });
  }
  const buy = [], sell = [];
  if (!staleOdds) {
    for (const r of rows) {
      if (r.eliminated) continue;
      // One BUY row per rival owner, priced on THEIR stake.
      for (const [owner, p] of Object.entries(r.owners)) {
        if (owner === ours || !(p > 0)) continue;
        const f = p / 100, edge = r.edge * f;
        if (edge >= 75 && r.edgePct >= 0.08) {
          buy.push({ ...r, owner, stake: p, modelFuture: r.modelFuture * f, marketFuture: r.marketFuture * f, edge,
            offerUpTo: Math.min(r.modelFuture * 0.85, r.marketFuture) * f, walkAway: r.modelFuture * 0.92 * f });
        }
      }
      if (r.ourStake > 0) {
        const f = r.ourStake / 100, edge = -r.edge * f;
        if (edge >= 75 && -r.edgePct >= 0.08) {
          sell.push({ ...r, stake: r.ourStake, modelFuture: r.modelFuture * f, marketFuture: r.marketFuture * f, edge: -edge,
            askAtLeast: Math.max(r.marketFuture, r.modelFuture * 1.15) * f, floor: r.modelFuture * 1.05 * f });
        }
      }
    }
  }
  buy.sort((a, b) => b.edge - a.edge); sell.sort((a, b) => a.edge - b.edge);
  return { buy, sell, all: rows.sort((a, b) => b.edge - a.edge), stale: staleOdds,
    reason: staleOdds ? "waiting for the sportsbooks to reprice after the latest results" : null };
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
  const trades = tradeFinder(gs, potForSettlement);
  return {
    season,
    projections: proj,
    tradeFinder: trades,
    oddsMeta,
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
    scoringProfile: { active: profiles.active, label: profiles.profiles[profiles.active]?.label || profiles.active, options: Object.fromEntries(Object.entries(profiles.profiles).map(([k, v]) => [k, v.label])) },
    payoutProfile: resolveProfile(profiles),
    meme: Object.fromEntries(MEME_IDS.filter(id => memes[id]).map(id => [id, memes[id].ts])),
    nflStandings,
    admin: true
  };
}
// What everyone else in the league sees: no private strategy tools.
function publicView(full) {
  const { tradeFinder, undoLabel, valuation, state, ...rest } = full;
  const teams = valuation?.teams ? Object.fromEntries(Object.entries(valuation.teams).map(([t, v]) => {
    const { shareModel, shareMarket, shareSim, shareP10, shareP90, ...keep } = v;
    return [t, keep];
  })) : null;
  const { ourGroupId, priorPot, targetMargin, groups, ...config } = state.config;
  return {
    ...rest,
    valuation: valuation ? { ...valuation, teams } : null,
    state: { ...state, config: { ...config, groups: groups.map(({ aliases, ...g }) => g) } },
    tradeFinder: null, undoLabel: null, admin: false
  };
}

// ---------- websocket ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
const clientIp = req => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
const wsPerIp = new Map();
function broadcast() {
  const full = view();
  const adminPayload = JSON.stringify({ type: "view", data: full });
  const publicPayload = JSON.stringify({ type: "view", data: publicView(full) });
  for (const c of wss.clients) if (c.readyState === 1) c.send(c.isAdmin ? adminPayload : publicPayload);
}
wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  const n = (wsPerIp.get(ip) || 0) + 1;
  if (n > 25) { ws.close(1013, "too many connections"); return; }
  wsPerIp.set(ip, n);
  ws.on("close", () => { const m = (wsPerIp.get(ip) || 1) - 1; m > 0 ? wsPerIp.set(ip, m) : wsPerIp.delete(ip); });
  ws.isAdmin = false;
  ws.send(JSON.stringify({ type: "view", data: publicView(view()) }));
  ws.on("message", raw => {
    if (raw.length > 1000) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === "auth") {
      ws.isAdmin = verifyToken(msg.key);
      ws.send(JSON.stringify({ type: "auth", ok: ws.isAdmin }));
      const full = view();
      ws.send(JSON.stringify({ type: "view", data: ws.isAdmin ? full : publicView(full) }));
    }
  });
});

// ---------- background: auto score sync + revaluation ----------
let revaluing = false;
async function syncScores({ force = false } = {}) {
  try {
    const before = schedule ? schedule.games.filter(g => g.final).length : -1;
    schedule = await fetchAndCache();
    const after = schedule.games.filter(g => g.final).length;
    try {
      nflStandings = await fetchStandings();
      fs.writeFileSync(DATA("standings-2026.json"), JSON.stringify(nflStandings, null, 1));
    } catch (e) { console.error("standings fetch failed:", e.message); }
    // Recompute when the code version OR any valuation input (lines, odds, active profile) changed.
    const effective = JSON.stringify([
      (() => { try { return JSON.parse(fs.readFileSync(DATA("win-totals-2026.json"), "utf8")); } catch { return null; } })(),
      loadMarketOdds(),
      resolveProfile(profiles)
    ]);
    const inputsHash = [...effective].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
    const stale = !valuation || valuation.version !== VALUATION_VERSION || valuation.inputsHash !== inputsHash;
    if (after !== before && before >= 0) setTimeout(() => refreshOdds({ minGapMs: 3 * 3600e3 }), 5000); // books reprice after finals
    if ((after !== before || force || stale) && !revaluing) {
      revaluing = true;
      try {
        const winTotals = JSON.parse(fs.readFileSync(DATA("win-totals-2026.json"), "utf8"));
        const marketOdds = loadMarketOdds();
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
setInterval(() => refreshOdds(), 24 * 60 * 60 * 1000); // futures from ESPN daily
syncScores().then(() => refreshOdds()); // on boot: schedule + valuation, then live odds — zero manual steps

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
app.get("/api/view", (req, res) => { const full = view(); res.json(isAdmin(req) ? full : publicView(full)); });
app.set("trust proxy", 1);
app.post("/api/auth", async (req, res) => {
  const now = Date.now(), ip = req.ip || "?";
  const recent = (authTries.get(ip) || []).filter(t => now - t < 60e3);
  if (recent.length >= 5) return res.status(429).json({ admin: false, error: "Too many tries — wait a minute." });
  recent.push(now); authTries.set(ip, recent);
  if (authTries.size > 5000) authTries.clear();
  if (scryptBusy) return res.status(429).json({ admin: false, error: "Busy — try again in a second." });
  scryptBusy = true;
  try {
    const ok = await checkPasscode(req.body?.key);
    res.json(ok ? { admin: true, token: issueToken() } : { admin: false });
  } finally { scryptBusy = false; }
});
app.post("/api/action", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "View-only — unlock with the commissioner code to make changes." });
  const { type, ...payload } = req.body || {};
  const fn = actions[type];
  if (!fn) return res.status(400).json({ error: `Unknown action: ${type}` });
  const result = fn(payload) || {};
  persist();
  broadcast();
  res.json({ ok: !result.error, ...result });
});
let lastPublicSync = 0;
// Which group this browser belongs to. Kept in a server-set cookie as well as localStorage:
// Safari wipes script-written storage after ~7 days without a visit, but not server-set cookies.
app.post("/api/me", (req, res) => {
  const g = String(req.body?.group || "");
  if (g !== "none" && !state.config.groups.some(x => x.id === g)) return res.status(400).json({ ok: false });
  res.cookie("cc_me", g, { maxAge: 400 * 86400e3, sameSite: "lax", secure: req.secure, httpOnly: false, path: "/" });
  res.json({ ok: true });
});

// Meme photos (the Bills fat finger, Fuller): admin uploads, everyone can see.
const IMG_TYPES = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47], webp: [0x52, 0x49, 0x46, 0x46] };
app.post("/api/admin/meme/:id", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "4mb" }), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin only" });
  const id = req.params.id;
  if (!MEME_IDS.includes(id)) return res.status(404).json({ ok: false, error: "unknown meme" });
  const buf = req.body;
  const kind = Buffer.isBuffer(buf) && Object.entries(IMG_TYPES).find(([, sig]) => sig.every((b, i) => buf[i] === b))?.[0];
  if (!kind) return res.status(400).json({ ok: false, error: "send a JPEG, PNG or WebP image" });
  fs.writeFileSync(memeFile(id), buf);
  memes[id] = { type: `image/${kind}`, ts: Date.now(), bytes: buf.length };
  fs.writeFileSync(memeMetaFile(id), JSON.stringify(memes[id]));
  broadcast();
  res.json({ ok: true, ...memes[id] });
});
app.delete("/api/admin/meme/:id", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin only" });
  const id = req.params.id;
  if (!MEME_IDS.includes(id)) return res.status(404).json({ ok: false });
  try { fs.unlinkSync(memeFile(id)); } catch {}
  try { fs.unlinkSync(memeMetaFile(id)); } catch {}
  memes[id] = null; broadcast(); res.json({ ok: true });
});
app.get("/api/meme/:id", (req, res) => {
  const id = req.params.id, m = memes[id];
  if (!MEME_IDS.includes(id) || !m || !fs.existsSync(memeFile(id))) return res.status(404).end();
  res.set({ "Content-Type": m.type, "Cache-Control": "public, max-age=86400" });
  res.sendFile(memeFile(id));
});

app.post("/api/sync", async (req, res) => {
  if (isAdmin(req)) return res.json(await syncScores({ force: !!req.body?.force }));
  if (Date.now() - lastPublicSync < 120e3) return res.json({ ok: true, skipped: true });
  lastPublicSync = Date.now();
  res.json(await syncScores());
});

// ---------- transcript log: every finalized speech segment, persisted to disk ----------
const TDIR = DATA("transcripts");
fs.mkdirSync(TDIR, { recursive: true });
const tFile = () => path.join(TDIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
app.post("/api/transcript", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
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
  for (const c of wss.clients) if (c.readyState === 1 && c.isAdmin) c.send(payload);
  res.json({ ok: true });
});
app.get("/api/transcript", (req, res) => {
  if (!isAdmin(req)) return res.json({ lines: [] });
  const lines = fs.existsSync(tFile())
    ? fs.readFileSync(tFile(), "utf8").trim().split("\n").slice(-80).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  res.json({ lines });
});

app.use(express.static(path.join(ROOT, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "dist", "index.html")));

server.listen(PORT, () => console.log(`Cardinal Calcutta war room on http://localhost:${PORT}`));

// Graceful shutdown: Railway sends SIGTERM to the old server on every deploy. Exiting with an
// error code made each replaced deploy show as "Deployment failed" (and emailed about it), and
// could drop a change still waiting in the 250 ms save debounce. Save now, close, exit 0.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — saving state and shutting down`);
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DATA("state.json"), JSON.stringify(state, null, 1)); } catch (e) { console.error("final save failed:", e.message); }
  for (const c of wss.clients) { try { c.close(1001, "server restarting"); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
