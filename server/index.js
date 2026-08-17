// Cardinal Calcutta war-room server.
// Single process: serves the built app, a JSON API, and a WebSocket that pushes the full
// computed view (auction state + live repricing + season earnings) on every change.
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TEAMS, TEAM_IDS, PAYOUT } from "../engine/teams.js";
import { valuate } from "../engine/sim.js";
import { fetchAndCache } from "../engine/fetch-schedule.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = p => path.join(ROOT, "data", p);
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
  auction: { phase: "setup", order: [], current: 0, bids: [], sales: {}, skipped: [] },
  trades: []
};

let state = fs.existsSync(DATA("state.json"))
  ? JSON.parse(fs.readFileSync(DATA("state.json"), "utf8"))
  : structuredClone(DEFAULT_STATE);
let undoStack = [];

let schedule = fs.existsSync(DATA("schedule-2026.json"))
  ? JSON.parse(fs.readFileSync(DATA("schedule-2026.json"), "utf8"))
  : null;
let valuation = fs.existsSync(DATA("valuation.json"))
  ? JSON.parse(fs.readFileSync(DATA("valuation.json"), "utf8"))
  : null;

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DATA("state.json"), JSON.stringify(state, null, 1)), 250);
}

// ---------- derived: earnings ledger from real results ----------
function payoutEvents() {
  if (!schedule) return [];
  const events = [];
  const finals = schedule.games.filter(g => g.final && g.homeScore != null);
  const firstPlayoff = {}; // team -> earliest playoff week seen
  for (const g of finals) {
    const winner = g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : null;
    if (g.seasontype === 2) {
      if (winner) events.push({ type: "regWin", team: winner, ts: g.date, credit: PAYOUT.regWin });
    } else if (g.seasontype === 3) {
      for (const t of [g.home, g.away]) {
        if (!(t in firstPlayoff) || g.week < firstPlayoff[t].week) firstPlayoff[t] = { week: g.week, ts: g.date };
      }
      const credit = { 1: PAYOUT.wcWin, 2: PAYOUT.divWin, 3: PAYOUT.confWin, 5: PAYOUT.sbWin }[g.week];
      const type = { 1: "wcWin", 2: "divWin", 3: "confWin", 5: "sbWin" }[g.week];
      if (winner && credit) events.push({ type, team: winner, ts: g.date, credit });
    }
  }
  for (const [team, info] of Object.entries(firstPlayoff)) {
    events.push({ type: "playoffBerth", team, ts: info.ts, credit: PAYOUT.playoffBerth });
    // Teams whose first playoff game is the divisional round had the bye = #1 seed.
    if (info.week === 2) events.push({ type: "oneSeed", team, ts: info.ts, credit: PAYOUT.oneSeed });
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
  const potEstimate = spent + (totalShare - soldShare) * rate;
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

function view() {
  const rp = repricing();
  const events = payoutEvents();
  const finalPot = rp.spent; // once auction done, actual pot = total sold
  const potForSettlement = state.auction.phase === "done" ? finalPot : rp.potEstimate;
  const gs = groupSummaries(events, finalPot);
  return {
    state,
    teams: TEAMS,
    valuation: valuation ? { computedAt: valuation.computedAt, gamesPlayed: valuation.gamesPlayed, teams: valuation.teams } : null,
    repricing: rp,
    potForSettlement,
    events,
    summaries: gs.groups,
    earnedByTeam: gs.earnedByTeam,
    scheduleFetchedAt: schedule?.fetchedAt || null
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
    if ((after !== before || force || !valuation) && !revaluing) {
      revaluing = true;
      try {
        const winTotals = JSON.parse(fs.readFileSync(DATA("win-totals-2026.json"), "utf8"));
        valuation = valuate(schedule.games, winTotals, 10000);
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
setInterval(() => syncScores(), 6 * 3600 * 1000);
syncScores(); // on boot: fresh schedule + valuation, zero manual steps

// ---------- actions ----------
const MIN_OPEN = 50;
const nextIncrement = amount => (amount < 500 ? 25 : 50);

function snapshot() {
  undoStack.push(structuredClone({ auction: state.auction, trades: state.trades }));
  if (undoStack.length > 100) undoStack.shift();
}

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
  setOrder({ order }) {
    const valid = order.filter(t => TEAM_IDS.includes(t));
    const missing = TEAM_IDS.filter(t => !valid.includes(t));
    state.auction.order = [...valid, ...missing];
  },
  shuffleOrder() {
    const arr = [...TEAM_IDS];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    state.auction.order = arr;
  },
  startAuction() {
    if (!state.auction.order.length) actions.shuffleOrder();
    state.auction.phase = "live";
    state.auction.current = 0;
  },
  logBid({ group, amount }) {
    snapshot();
    const team = state.auction.order[state.auction.current];
    const bidsOnTeam = state.auction.bids.filter(b => b.team === team);
    const top = bidsOnTeam.length ? bidsOnTeam[bidsOnTeam.length - 1].amount : 0;
    const amt = amount != null ? Number(amount) : top === 0 ? MIN_OPEN : top + nextIncrement(top);
    state.auction.bids.push({ team, group, amount: amt, ts: new Date().toISOString() });
  },
  sold({ group, amount }) {
    snapshot();
    const team = state.auction.order[state.auction.current];
    const bidsOnTeam = state.auction.bids.filter(b => b.team === team);
    const last = bidsOnTeam[bidsOnTeam.length - 1];
    const g = group || last?.group;
    const amt = amount != null ? Number(amount) : last?.amount;
    if (!g || !amt) return { error: "No bid to close — log a bid or pass group+amount." };
    state.auction.sales[team] = { group: g, amount: amt, ts: new Date().toISOString() };
    if (state.auction.current < state.auction.order.length - 1) state.auction.current++;
    else state.auction.phase = "done";
  },
  skipTeam() {
    snapshot();
    const team = state.auction.order[state.auction.current];
    state.auction.skipped.push(team);
    if (state.auction.current < state.auction.order.length - 1) state.auction.current++;
    else state.auction.phase = "done";
  },
  editSale({ team, amount, group }) {
    snapshot();
    const s = state.auction.sales[team];
    if (!s) return { error: "Team is not sold." };
    if (amount != null && Number(amount) > 0) s.amount = Number(amount);
    if (group) s.group = group;
  },
  editLastBid({ amount, group }) {
    snapshot();
    const team = state.auction.order[state.auction.current];
    const arr = state.auction.bids;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].team === team) {
        if (amount != null && Number(amount) > 0) arr[i].amount = Number(amount);
        if (group) arr[i].group = group;
        return;
      }
    }
    return { error: "No bid to edit." };
  },
  putOnBlock({ team }) {
    const idx = state.auction.order.indexOf(team);
    if (idx < 0) return { error: "Unknown team." };
    if (state.auction.sales[team]) return { error: "Already sold — reopen it instead." };
    state.auction.skipped = state.auction.skipped.filter(t => t !== team);
    state.auction.current = idx;
    state.auction.phase = "live";
  },
  reopenTeam({ team }) {
    snapshot();
    delete state.auction.sales[team];
    state.auction.skipped = state.auction.skipped.filter(t => t !== team);
    state.auction.bids = state.auction.bids.filter(b => b.team !== team);
    const idx = state.auction.order.indexOf(team);
    if (idx >= 0) state.auction.current = idx;
    state.auction.phase = "live";
  },
  gotoTeam({ index }) {
    const i = Number(index);
    if (i >= 0 && i < state.auction.order.length) state.auction.current = i;
  },
  undo() {
    const prev = undoStack.pop();
    if (prev) { state.auction = prev.auction; state.trades = prev.trades; }
  },
  addTrade({ team, from, to, pct, cash, ts }) {
    snapshot();
    state.trades.push({
      id: `t${Date.now()}`,
      team, from, to,
      pct: Number(pct),
      cash: Number(cash),
      ts: ts || new Date().toISOString()
    });
  },
  deleteTrade({ id }) {
    snapshot();
    state.trades = state.trades.filter(t => t.id !== id);
  },
  resetAuction() {
    snapshot();
    state.auction = { phase: "setup", order: [], current: 0, bids: [], sales: {}, skipped: [] };
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
    team: state.auction.order[state.auction.current] || null
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
