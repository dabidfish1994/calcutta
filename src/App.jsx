import React, { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, membersOf } from "./avatars.jsx";

import { fmt$, fmtPct, logo, moji, act, shortName, memberNames, groupName, getAdminKey, setAdminKey, useMe, useRoute } from "./util.jsx";
import { Season, Rules, WhoAreYou } from "./viewer.jsx";

function useLive(onTranscript) {
  const [view, setView] = useState(null);
  const [tick, setTick] = useState(0); // bump to reconnect after unlocking/locking
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;
  const viewRef = useRef(null);
  viewRef.current = view;
  useEffect(() => {
    let ws, closed = false, retry;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      let authPending = false;
      ws.onopen = () => { const k = getAdminKey(); if (k) { authPending = true; ws.send(JSON.stringify({ type: "auth", key: k })); } };
      ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === "auth") { authPending = false; if (!msg.ok) setAdminKey(""); } // expired session: fall back to viewer
        // A reconnecting admin device gets one public frame before its session is re-checked; skip it
        // so open edit forms don't unmount.
        if (msg.type === "view" && !(authPending && !msg.data.admin && viewRef.current?.admin)) setView(msg.data);
        if (msg.type === "transcript") cbRef.current?.(msg.line);
      };
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 1500); };
    };
    connect();
    fetch("/api/view", { headers: { "x-admin-key": getAdminKey() } }).then(r => r.json()).then(setView).catch(() => {});
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, [tick]);
  return [view, () => setTick(t => t + 1)];
}

const VIEW_TABS = [
  { id: "season", label: "Season", icon: "🏈" },
  { id: "odds", label: "Odds", icon: "🎲" },
  { id: "rules", label: "Rules", icon: "📜" }
];
// Editing tabs, shown only after unlocking with the commissioner code.
const ADMIN_TABS = [
  { id: "trades", label: "Trades", icon: "🤝" },
  { id: "board", label: "Board", icon: "📋" },
  { id: "draft", label: "Draft", icon: "🔨" },
  { id: "setup", label: "Setup", icon: "⚙️" }
];

export default function App() {
  const [lines, setLines] = useState([]);
  const [view, reconnect] = useLive(line => setLines(l => [...l.slice(-79), line]));
  const [route, go] = useRoute();
  const [me, setMe] = useMe(view);
  const [picking, setPicking] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  useEffect(() => { window.scrollTo(0, 0); }, [route.tab]);
  useEffect(() => {
    if (view?.admin) fetch("/api/transcript", { headers: { "x-admin-key": getAdminKey() } }).then(r => r.json()).then(d => setLines(d.lines || [])).catch(() => {});
  }, [view?.admin]);
  if (!view) return <div className="loading">🏈 Loading the Cardinal Calcutta…</div>;
  const admin = !!view.admin;
  const seasonOn = !!view.seasonStarted || view.state.auction.phase === "done";
  if (seasonOn) { try { localStorage.setItem("cc-listen", "0"); } catch {} }
  const tabs = admin ? [...VIEW_TABS, ...ADMIN_TABS] : VIEW_TABS;
  const tab = tabs.some(t => t.id === route.tab) ? route.tab : (!seasonOn && admin ? "draft" : "season");
  const askWho = seasonOn && (me === undefined || picking);
  const meName = me ? view.state.config.groups.find(g => g.id === me)?.name : null;
  let body;
  if (tab === "season") body = <Season view={view} me={me} />;
  else if (tab === "odds") body = <Odds view={view} />;
  else if (tab === "rules") body = <Rules view={view} me={me} />;
  else if (tab === "trades") body = <Trades view={view} />;
  else if (tab === "board") body = <Board view={view} />;
  else if (tab === "draft") body = <Draft view={view} lines={lines} />;
  else body = <Setup view={view} />;
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/season">🏈 <span>Cardinal Calcutta</span></a>
        <div className="topright">
          {seasonOn ? <span className="potbadge">pot <b>{fmt$(view.potForSettlement)}</b></span> : <PotBadge view={view} />}
          {seasonOn && (
            <button className="mebtn" onClick={() => setPicking(true)} aria-label={meName ? `Viewing as ${memberNames(meName)} — change` : "Pick your group"}>
              {meName ? <><span className="crew">{membersOf(meName).map(n => <Avatar key={n} name={n} title={n} size={22} mode="hero" />)}</span><span className="mename">{memberNames(meName)}</span></> : <span>Pick your group</span>}
              <span aria-hidden="true">▾</span>
            </button>
          )}
          <button className={"lockbtn" + (admin ? " on" : "")} title={admin ? "War room unlocked — tap to lock this device" : "Commissioner unlock"}
            onClick={() => { if (admin) { setAdminKey(""); reconnect(); if (ADMIN_TABS.some(t => t.id === route.tab)) go({ tab: "season", arg: null }); } else setUnlocking(true); }}>
            {admin ? "🔓" : "🔒"}
          </button>
        </div>
      </header>
      <main>{body}</main>
      <nav className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={t.id === tab ? "on" : ""} aria-current={t.id === tab ? "page" : undefined} onClick={() => go({ tab: t.id, arg: null, team: null, group: null })}>
            <span className="tabmoji">{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>
      {askWho && <WhoAreYou view={view} me={me} onPick={g => { setMe(g); setPicking(false); }} onClose={() => { if (me === undefined) setMe("none"); setPicking(false); }} />}
      {unlocking && <Unlock onDone={ok => { setUnlocking(false); if (ok) reconnect(); }} />}
    </div>
  );
}

function Unlock({ onDone }) {
  const [key, setKey] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr(null);
    const r = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (r?.admin && r.token) { setAdminKey(r.token); onDone(true); } else setErr(r?.error || "That code didn't work.");
  };
  return (
    <div className="sheetback" onClick={() => onDone(false)}>
      <form className="sheet who" role="dialog" aria-modal="true" aria-label="Commissioner unlock" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <h2>🔒 War room</h2>
        <p className="dim small">Editing (draft fixes, trades, setup) and our private tools need the code. Everything else is open to the league.</p>
        <input type="password" autoFocus autoComplete="current-password" value={key} onChange={e => setKey(e.target.value)} placeholder="code" aria-label="Code" />
        {err && <p className="red small">{err}</p>}
        <div className="row gap"><button className="go" disabled={busy || !key}>{busy ? "Checking…" : "Unlock"}</button><button type="button" onClick={() => onDone(false)}>Cancel</button></div>
      </form>
    </div>
  );
}

function PotBadge({ view }) {
  const { repricing, state } = view;
  const heat = repricing.heat;
  const heatCls = heat > 1.08 ? "hot" : heat < 0.92 ? "cold" : "warm";
  return (
    <span className="potbadge">
      {state.auction.paused && <em className="warm">⏸ paused</em>}
      pot est <b>{fmt$(repricing.potEstimate)}</b>
      {state.auction.phase === "live" && repricing.soldShare > 0 && (
        <em className={heatCls}>{heat > 1.08 ? "🔥" : heat < 0.92 ? "🧊" : ""}{heat > 1 ? "+" : ""}{Math.round((heat - 1) * 100)}% {heat >= 1 ? "hot" : "cold"}</em>
      )}
    </span>
  );
}

// ---------------- adaptive speech understanding ----------------
const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const REL_RE = /\b(more|another|bump|raise|add|plus|up)\b/i;

// Parse spoken auction talk into candidate bid amounts, given the current top bid.
export function extractAmounts(text, topBid = 0) {
  // Speech APIs write big amounts with thousands separators ("$2,500") — de-comma before matching.
  text = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const raw = [];
  for (const m of text.matchAll(/\$?\b([1-9]\d{1,3})\b/g)) raw.push(Number(m[1]));
  const toks = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(t => t && t !== "and");
  for (let k = 0; k < toks.length; k++) {
    if (toks[k] === "grand") toks[k] = "thousand";
    if (toks[k] === "a" && (toks[k + 1] === "hundred" || toks[k + 1] === "thousand" || toks[k + 1] === "grand")) toks[k] = "one";
  }
  for (let i = 0; i < toks.length; i++) {
    let val = 0, j = i;
    const small = t => (ONES[t] ?? null);
    if (toks[j] === "hundred") { val = 100; j++; } // "bump it a hundred"
    else if (small(toks[j]) != null) {
      let n = small(toks[j]); j++;
      if (toks[j] === "thousand") { val = n * 1000; j++;
        if (small(toks[j]) != null && toks[j + 1] === "hundred") { val += small(toks[j]) * 100; j += 2; }
        if (TENS[toks[j]] != null) { val += TENS[toks[j]]; j++; if (small(toks[j]) != null) { val += small(toks[j]); j++; } }
        else if (small(toks[j]) != null) { val += small(toks[j]); j++; }
      } else if (toks[j] === "hundred") { val = n * 100; j++;
        if (TENS[toks[j]] != null) { val += TENS[toks[j]]; j++; if (small(toks[j]) != null) { val += small(toks[j]); j++; } }
        else if (small(toks[j]) != null) { val += small(toks[j]); j++; }
      } else if (TENS[toks[j]] != null) { // "three fifty" -> 350, "twelve fifty" -> 1250
        val = n * 100 + TENS[toks[j]]; j++;
        if (small(toks[j]) != null) { val += small(toks[j]); j++; }
      }
    } else if (TENS[toks[j]] != null) { // bare "fifty" / "seventy five"
      val = TENS[toks[j]]; j++;
      if (small(toks[j]) != null) { val += small(toks[j]); j++; }
      if (toks[j] === "hundred") { // "twenty five hundred" -> 2500
        val = val * 100; j++;
        if (TENS[toks[j]] != null) { val += TENS[toks[j]]; j++; if (small(toks[j]) != null) { val += small(toks[j]); j++; } }
        else if (small(toks[j]) != null) { val += small(toks[j]); j++; }
      } else if (val % 10 !== 0 && TENS[toks[j]] != null) { // "sixty seven fifty" -> 6750 (not "fifty fifty" banter)
        val = val * 100 + TENS[toks[j]]; j++;
        if (small(toks[j]) != null) { val += small(toks[j]); j++; }
      }
    }
    if (val >= 25) { raw.push(val); i = j - 1; }
  }
  const relative = REL_RE.test(text) && topBid > 0;
  const out = new Set();
  for (let v of raw) {
    v = Math.round(v / 25) * 25;
    if (v >= 50 && v > topBid) out.add(v);
    else if (relative && v >= 25 && v <= 1000) out.add(topBid + v);
  }
  return [...out].filter(v => v >= 50 && v <= 7000);
}

// Guess which group spoke, from group names + aliases ("joon, gunther, dave").
const STOP = new Set(["group", "team", "the", "a", "an", "of", "us"]);
export function matchGroup(text, groups) {
  const toks = new Set(text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/));
  const hits = [];
  for (const g of groups) {
    const words = [
      ...String(g.name || "").toLowerCase().split(/[\s(/,)]+/),
      ...String(g.aliases || "").toLowerCase().split(/[\s,]+/)
    ].filter(w => w.length > 2 && !STOP.has(w));
    if (words.some(w => toks.has(w))) hits.push(g.id);
  }
  return hits.length === 1 ? hits[0] : null;
}

// Recognize which NFL team the room is talking about. Nicknames beat cities;
// genuinely ambiguous phrases ("New York", "Los Angeles") return both candidates.
const TEAM_PHRASES = {
  bills: "BUF", buffalo: "BUF", dolphins: "MIA", fins: "MIA", miami: "MIA",
  patriots: "NE", pats: "NE", "new england": "NE", jets: "NYJ", giants: "NYG",
  ravens: "BAL", bengals: "CIN", cincinnati: "CIN", cincy: "CIN",
  browns: "CLE", cleveland: "CLE", steelers: "PIT", pittsburgh: "PIT",
  texans: "HOU", houston: "HOU", colts: "IND", indy: "IND", indianapolis: "IND",
  jaguars: "JAX", jags: "JAX", jacksonville: "JAX", titans: "TEN", tennessee: "TEN",
  broncos: "DEN", denver: "DEN", chiefs: "KC", "kansas city": "KC",
  raiders: "LV", "las vegas": "LV", chargers: "LAC", bolts: "LAC",
  cowboys: "DAL", dallas: "DAL", eagles: "PHI", philly: "PHI", philadelphia: "PHI",
  commanders: "WSH", washington: "WSH", bears: "CHI", chicago: "CHI",
  lions: "DET", detroit: "DET", packers: "GB", "green bay": "GB",
  vikings: "MIN", vikes: "MIN", minnesota: "MIN", falcons: "ATL", atlanta: "ATL",
  panthers: "CAR", carolina: "CAR", saints: "NO", "new orleans": "NO",
  buccaneers: "TB", bucs: "TB", "tampa bay": "TB", tampa: "TB",
  cardinals: "ARI", cards: "ARI", arizona: "ARI", rams: "LAR",
  niners: "SF", "49ers": "SF", "forty niners": "SF", "san francisco": "SF",
  seahawks: "SEA", seattle: "SEA", hawks: "SEA", baltimore: "BAL",
  "new york": ["NYG", "NYJ"], "los angeles": ["LAR", "LAC"]
};
export function detectTeams(text) {
  // The pool is literally named "Cardinal Calcutta" — that phrase is never Arizona coming up for bid.
  const scrubbed = text.toLowerCase().replace(/cardinal'?s?\s+calcutta/g, " ");
  const norm = " " + scrubbed.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() + " ";
  const found = new Set();
  const maybes = [];
  let rest = norm;
  for (const [phrase, team] of Object.entries(TEAM_PHRASES).sort((a, b) => b[0].length - a[0].length)) {
    if (rest.includes(` ${phrase} `)) {
      rest = rest.replaceAll(` ${phrase} `, " · ");
      if (Array.isArray(team)) maybes.push(team);
      else found.add(team);
    }
  }
  // "New York" only stays ambiguous if no nickname resolved it in the same breath.
  const ambiguous = [];
  for (const pair of maybes) {
    if (!pair.some(t => found.has(t))) ambiguous.push(pair);
  }
  return { teams: [...found], ambiguous };
}

const CUE_RE = /\b(next|block|selling|up now|now up|moving on|here we go|switch)\b/i;

function SpeechPanel({ onFinal, autoStart = false }) {
  const [listening, setListening] = useState(false);
  const [line, setLine] = useState("");
  const [supported] = useState(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  const recRef = useRef(null);
  const triedAuto = useRef(false);

  const stop = () => { setListening(false); const r = recRef.current; recRef.current = null; try { r?.stop(); } catch {} };
  const start = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = e => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const txt = e.results[i][0].transcript;
        interim = txt;
        if (e.results[i].isFinal && txt.trim()) onFinal(txt.trim());
      }
      setLine(interim.slice(-90));
    };
    rec.onend = () => { if (recRef.current === rec) { try { rec.start(); } catch { stop(); } } };
    rec.onerror = ev => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") stop(); };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };
  useEffect(() => () => stop(), []);
  // The device that started the draft becomes the listener automatically (mic permission
  // persists per origin, so no extra tap after the first session).
  useEffect(() => {
    if (autoStart && !listening && !triedAuto.current && localStorage.getItem("cc-listen") === "1") {
      triedAuto.current = true;
      try { start(); } catch {}
    }
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!supported) return <p className="dim">Speech recognition needs Chrome or Safari.</p>;
  return (
    <div className="speech">
      <button className={listening ? "on" : ""} onClick={() => {
        if (listening) { localStorage.setItem("cc-listen", "0"); stop(); }
        else { localStorage.setItem("cc-listen", "1"); start(); }
      }}>
        {listening ? "🎙 Listening…" : "🎙 Listen to the draft"}
      </button>
      {listening && <span className="dim transcript">{line || "…"}</span>}
    </div>
  );
}

function ManualLine({ onFinal }) {
  const [text, setText] = useState("");
  const submit = () => { if (text.trim()) { onFinal(text.trim()); setText(""); } };
  return (
    <div className="speech">
      <input
        value={text}
        placeholder="mic missed it? type what was said…"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") submit(); }}
        style={{ flex: 1 }}
      />
      <button onClick={submit}>➤</button>
    </div>
  );
}

function TranscriptLog({ lines }) {
  if (!lines.length) return null;
  return (
    <details className="upnext">
      <summary><h3 style={{ display: "inline" }}>Transcript ({lines.length})</h3></summary>
      <div className="tlog">
        {[...lines].reverse().map((l, i) => (
          <div key={i} className="tline">
            <span className="dim">{new Date(l.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{l.team ? ` · ${l.team}` : ""}</span>
            <span>{l.text}</span>
            {l.amounts?.length > 0 && <b className="amber">{l.amounts.map(fmt$).join(" ")}</b>}
          </div>
        ))}
      </div>
    </details>
  );
}

// ---------------- DRAFT ----------------
function Draft({ view, lines }) {
  const { state, teams, valuation, repricing, summaries } = view;
  const { auction, config } = state;
  const [customAmt, setCustomAmt] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [notice, setNotice] = useState(null);
  const dedupe = useRef({ amount: 0, ts: 0, sold: 0 });

  const team = auction.onBlock;
  const paused = !!auction.paused;
  const suggestionRef = useRef(null);
  suggestionRef.current = suggestion;
  useEffect(() => {
    // Only clear cards that belong to a DIFFERENT team — the opening-bid card created in the
    // same utterance as an auto-block must survive the block landing.
    setSuggestion(s => (s && (s.kind === "bid" || s.kind === "sold") && s.team !== team ? null : s));
    setCustomAmt(null);
    dedupe.current = { amount: 0, ts: 0, sold: 0 };
  }, [team]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  // Entering a pause voids any pending card and dedupe memory — a card that survives a
  // 15-minute break must never resurface looking fresh.
  useEffect(() => {
    if (paused) {
      setSuggestion(null);
      dedupe.current = { amount: 0, ts: 0, sold: 0 };
    }
  }, [paused]);

  const bidsOnTeam = auction.bids.filter(b => b.team === team);
  const top = bidsOnTeam.reduce((a, b) => (!a || b.amount >= a.amount ? b : a), null);
  useEffect(() => { setCustomAmt(null); }, [top?.amount]);
  const liveRef = useRef({});
  liveRef.current = { team, top, sales: auction.sales, groups: config.groups, paused };

  const flash = msg => setNotice(msg);
  const surface = r => { if (r?.error) flash({ text: `⚠️ ${r.error}` }); };

  // Dedupe stamps happen HERE, on confirm — not when a card is merely shown — so dismissing
  // a false card never swallows the real event that follows.
  const confirmBid = (t, group, amount) => {
    dedupe.current = { ...dedupe.current, amount, ts: Date.now() };
    act("logBid", { team: t, group, amount }).then(surface);
    setSuggestion(null);
    setCustomAmt(null);
  };
  const confirmSold = t => {
    dedupe.current.sold = Date.now();
    const next = suggestionRef.current?.kind === "sold" ? suggestionRef.current.next : null;
    act("sold", { team: t }).then(r => {
      surface(r);
      if (!r?.error && next) act("blockTeam", { team: next }).then(surface);
    });
    setSuggestion(null);
    setCustomAmt(null);
  };

  const handleFinal = (txt, { manual = false } = {}) => {
    const { team: curTeam, top: curTop, sales, groups } = liveRef.current;
    const topAmt = curTop?.amount || 0;
    const amounts = extractAmounts(txt, topAmt);
    const group = matchGroup(txt, groups);
    const det = detectTeams(txt);
    fetch("/api/transcript", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: txt, amounts, group })
    }).catch(() => {});
    if (liveRef.current.paused) {
      // Mic lines: keep transcribing silently. Typed lines are explicit commands — tell the operator why nothing happened.
      if (manual) flash({ text: "⏸ Paused — resume the draft to log that." });
      return;
    }
    const now = Date.now();
    const unsold = det.teams.filter(t => !sales[t]);
    const ambiguousUnsold = det.ambiguous.map(pair => pair.filter(t => !sales[t])).filter(p => p.length);

    // 1) "sold" closes the current team — and may name the next team in the same breath.
    // Confident calls (a clean "sold!", "going twice sold", or a typed line) lock in
    // immediately with an undo pill; murky ones still get a confirm card.
    if (curTeam && /\bsold\b/i.test(txt) && (manual || now - dedupe.current.sold > 6000)) {
      const next = unsold.filter(t => t !== curTeam);
      const nextOne = next.length === 1 ? next[0] : null;
      const short = txt.trim().split(/\s+/).length <= 4;
      const confident = curTop && (manual || short || /\bgoing\b/i.test(txt));
      if (confident) {
        dedupe.current.sold = now;
        act("sold", { team: curTeam }).then(r => {
          surface(r);
          if (!r?.error) {
            const gname = liveRef.current.groups.find(g => g.id === curTop.group)?.name || "";
            flash({ text: `🔨 ${moji(curTeam)} ${curTeam} sold ${fmt$(curTop.amount)} · ${shortName(gname)}`, undo: () => act("undo").then(surface) });
            if (nextOne) act("blockTeam", { team: nextOne }).then(surface);
          }
        });
      } else {
        setSuggestion({ kind: "sold", team: curTeam, heard: txt, next: nextOne });
      }
      return;
    }

    // 2) which team is up? Auto-block only on a confident call: a cue phrase ("next up…"),
    // a short team-focused line, or a typed line — long banter gets a confirm card instead.
    if (!curTeam) {
      const tokCount = txt.trim().split(/\s+/).length;
      const confident = unsold.length === 1 && !ambiguousUnsold.length && (manual || CUE_RE.test(txt) || tokCount <= 5);
      if (confident) {
        const blocked = unsold[0];
        act("blockTeam", { team: blocked }).then(r => {
          surface(r);
          // "Broncos — Joon opens at fifty": price + speaker heard, lock the opening bid too.
          if (!r?.error && amounts.length && group) {
            act("logBid", { team: blocked, group, amount: Math.max(...amounts) }).then(surface);
          }
        });
        flash({ text: `${moji(blocked)} Heard it — ${blocked} on the block`, undo: () => act("clearBlock") });
        if (amounts.length && !group) setSuggestion({ kind: "bid", team: blocked, amount: Math.max(...amounts), group: null, heard: txt });
        return;
      }
      const cands = [...new Set([...unsold, ...ambiguousUnsold.flat()])];
      if (cands.length) {
        setSuggestion({ kind: "team", candidates: cands, heard: txt });
        return;
      }
    } else if ((unsold.some(t => t !== curTeam) || ambiguousUnsold.length) && CUE_RE.test(txt)) {
      // A different team named with a "next up"-style cue while one is on the block.
      if (suggestionRef.current?.kind === "sold") {
        // Never clobber an unconfirmed sale — attach the next team to the sold card instead.
        const next = unsold.filter(t => t !== curTeam);
        if (next.length === 1) setSuggestion(s => (s?.kind === "sold" ? { ...s, next: next[0] } : s));
        return;
      }
      const cands = [...new Set([...unsold.filter(t => t !== curTeam), ...ambiguousUnsold.flat()])];
      setSuggestion({ kind: "team", candidates: cands, heard: txt });
      return;
    }

    // 3) bid amounts on the current team. Price + identified speaker = lock it in with an
    // undo pill; unknown speaker still asks who said it.
    if (curTeam && amounts.length) {
      const amount = Math.max(...amounts);
      if (!manual && amount === dedupe.current.amount && now - dedupe.current.ts < 8000) return;
      if (group) {
        dedupe.current = { ...dedupe.current, amount, ts: now };
        act("logBid", { team: curTeam, group, amount }).then(r => {
          surface(r);
          if (!r?.error) {
            const gname = liveRef.current.groups.find(g => g.id === group)?.name || "";
            flash({ text: `🔊 ${fmt$(amount)} · ${shortName(gname)} — locked in`, undo: () => act("undo").then(surface) });
          }
        });
      } else {
        setSuggestion({ kind: "bid", team: curTeam, amount, group, heard: txt });
      }
    }
  };

  if (auction.phase === "setup")
    return (
      <div className="pad">
        <h2>Draft night</h2>
        <p>No order needed — hit start and <b>this device begins listening immediately</b>. Teams it hears go on the block, bids with a recognized voice lock in automatically (undo pill if it's wrong), and it only asks when it genuinely can't tell who spoke. Set groups + aliases in <b>Setup</b> first.</p>
        <button className="big go" onClick={() => { localStorage.setItem("cc-listen", "1"); act("startAuction"); }}>🏈 Start draft &amp; listen</button>
        {!valuation && <p className="dim">Valuations are computing from the live schedule + win totals…</p>}
        <BestRemaining view={view} title="Value board" />
      </div>
    );

  if (auction.phase === "done")
    return (
      <div className="pad">
        <h2>🎉 Auction complete</h2>
        <p>Head to <b>Board</b> (prices stay editable there) and <b>Season</b>.</p>
        <TranscriptLog lines={lines} />
      </div>
    );

  const v = team ? valuation?.teams?.[team] : null;
  const fair = team ? repricing.fair[team] || 0 : 0;
  const target = fair * config.targetMargin;
  const nextBid = top ? top.amount + (top.amount < 500 ? 25 : 50) : 50;
  const bidAmt = customAmt ?? nextBid;
  const status = !team ? "open" : !top ? "open" : top.amount <= target ? "green" : top.amount <= fair ? "amber" : "red";

  return (
    <div className="pad draft">
      {paused && (
        <div className="pausebanner">⏸ Draft paused — bidding and sales are locked on every device. Undo and Board price fixes (✎) still work.</div>
      )}
      <div className="draftgrid">
      <div className="draftmain">
      <div className="budgets">
        {config.groups.map(g => {
          const s = summaries[g.id];
          const ours = g.id === config.ourGroupId;
          return (
            <div key={g.id} className={"chip" + (ours ? " ours" : "")} title={memberNames(g.name)}>
              <span>{shortName(g.name)}</span><b>{fmt$(s.remaining)}</b>
            </div>
          );
        })}
      </div>

      {team ? (
        <div className={"block " + status}>
          <div className="blockhead">
            <img src={logo(team)} alt="" />
            <div style={{ flex: 1 }}>
              <h1>{moji(team)} {teams[team].name}</h1>
              <span className="dim">{teams[team].conf} {teams[team].div} · {Object.keys(auction.sales).length} of 32 sold</span>
            </div>
            <button className="tiny" title="Wrong team? Clear the block" onClick={() => act("clearBlock")}>✕</button>
          </div>
          {v ? (
            <div className="stats">
              <div><label>share</label><b>{v.share.toFixed(2)}%</b></div>
              <div><label>E[wins]</label><b>{v.expWins.toFixed(1)}</b></div>
              <div><label>P(playoffs)</label><b>{Math.round(v.pPlayoffs * 100)}%</b></div>
              <div><label>P(SB)</label><b>{(v.pSbWin * 100).toFixed(1)}%</b></div>
            </div>
          ) : <p className="dim">no valuation yet</p>}
          <div className="prices">
            <div className="price"><label>target</label><b className="green">{fmt$(target)}</b></div>
            <div className="price main"><label>fair / max</label><b>{fmt$(fair)}</b></div>
            <div className="price"><label>top bid</label>
              <b>{top ? `${fmt$(top.amount)} · ${shortName(groupName(config, top.group))}` : "—"}</b>
              {top && (
                <button className="tiny" title="Correct the top bid"
                  onClick={() => {
                    const amt = window.prompt("Correct top bid amount:", top.amount);
                    if (amt && Number(amt) > 0) act("editLastBid", { amount: Number(amt) });
                  }}>✎</button>
              )}
            </div>
          </div>
          {status === "green" && top && <div className="verdict green">💎 Under target — hammer time.</div>}
          {status === "red" && <div className="verdict">🚨 Over fair — let someone else buy the trophy.</div>}
          {status === "amber" && <div className="verdict amber">🤔 At fair — only if the plan says so.</div>}
        </div>
      ) : (
        <div className="block open idle">
          <h1>👂 Listening for the next team…</h1>
          <p className="dim">Say it on the call ("next up, the Broncos") and it lands here — or pick manually below.</p>
        </div>
      )}

      <SpeechPanel onFinal={handleFinal} autoStart={auction.phase === "live" && !view.seasonStarted} />
      <ManualLine onFinal={txt => handleFinal(txt, { manual: true })} />

      {notice && (
        <div className="notice">
          <span>{notice.text}</span>
          {notice.undo && <button className="tiny" onClick={() => { notice.undo(); setNotice(null); }}>undo</button>}
        </div>
      )}

      {!paused && suggestion?.kind === "team" && (
        <div className="suggest">
          <div className="suggesthead">
            Heard a team{team ? " (switch?)" : ""} — which one?
            <span className="dim transcript">“{suggestion.heard}”</span>
          </div>
          <div className="groupbtns">
            {suggestion.candidates.map(t => (
              <button key={t} className="go" onClick={() => { act("blockTeam", { team: t }); setSuggestion(null); }}>
                {moji(t)} {teams[t].name}
              </button>
            ))}
            <button onClick={() => setSuggestion(null)}>✕</button>
          </div>
        </div>
      )}
      {!paused && suggestion?.kind === "bid" && suggestion.team === team && (
        <div className="suggest">
          <div className="suggesthead">
            Heard <b>{fmt$(suggestion.amount)}</b>{suggestion.group ? <> from <b>{shortName(groupName(config, suggestion.group))}</b></> : " — who said it?"}
            <span className="dim transcript">“{suggestion.heard}”</span>
          </div>
          <div className="groupbtns">
            {suggestion.group && (
              <button className="go"
                disabled={!summaries[suggestion.group] || summaries[suggestion.group].remaining < suggestion.amount}
                onClick={() => confirmBid(suggestion.team, suggestion.group, suggestion.amount)}>
                ✓ Confirm {fmt$(suggestion.amount)} · {memberNames(groupName(config, suggestion.group))}
              </button>
            )}
            {config.groups.filter(g => g.id !== suggestion.group).map(g => (
              <button key={g.id} className={g.id === config.ourGroupId ? "ours" : ""}
                disabled={summaries[g.id].remaining < suggestion.amount}
                onClick={() => confirmBid(suggestion.team, g.id, suggestion.amount)}>
                {memberNames(g.name)}
              </button>
            ))}
            <button onClick={() => setSuggestion(null)}>✕</button>
          </div>
        </div>
      )}
      {!paused && suggestion?.kind === "sold" && suggestion.team === team && (
        <div className="suggest">
          <div className="suggesthead">
            Heard <b>SOLD</b> — confirm {top ? `${fmt$(top.amount)} to ${shortName(groupName(config, top.group))}` : "(no bid logged yet)"}?
            {suggestion.next && <span className="dim">then {moji(suggestion.next)} {suggestion.next} goes up next</span>}
            <span className="dim transcript">“{suggestion.heard}”</span>
          </div>
          <div className="groupbtns">
            <button className="go" disabled={!top} onClick={() => confirmSold(suggestion.team)}>🔨 Confirm sale</button>
            <button onClick={() => setSuggestion(null)}>✕</button>
          </div>
        </div>
      )}

      {team && !paused && (
        <div className="bidrow">
          <div className="stepper">
            <button onClick={() => setCustomAmt(Math.max(50, bidAmt - (bidAmt <= 500 ? 25 : 50)))}>−</button>
            <span onClick={() => {
              const amt = window.prompt("Bid amount:", bidAmt);
              if (amt && Number(amt) > 0) setCustomAmt(Number(amt));
            }}>{fmt$(bidAmt)}</span>
            <button onClick={() => setCustomAmt(bidAmt + (bidAmt < 500 ? 25 : 50))}>+</button>
          </div>
          <div className="groupbtns members">
            {config.groups.map(g => (
              <button
                key={g.id}
                disabled={summaries[g.id].remaining < bidAmt || bidAmt <= (top?.amount || 0)}
                className={g.id === config.ourGroupId ? "ours" : ""}
                onClick={() => confirmBid(team, g.id, bidAmt)}
              >
                {memberNames(g.name)}
              </button>
            ))}
          </div>
        </div>
      )}

      {!team && !paused && <QuickPick view={view} />}
      <BestRemaining view={view} title="Best remaining" />
      <SoldTicker view={view} />
      <TranscriptLog lines={lines} />
      </div>
      <GroupsPanel view={view} />
      </div>

      <div className="stickybar">
        <button className="sold" disabled={!team || !top || paused} onClick={() => confirmSold(team)}>
          🔨 SOLD {top ? `· ${fmt$(top.amount)}` : ""}
        </button>
        <button disabled={!view.undoLabel} title={view.undoLabel ? `Undo ${view.undoLabel}` : "Nothing to undo"}
          onClick={() => act("undo").then(surface)}>
          ↩︎<span className="lbl"> {view.undoLabel ? `Undo ${view.undoLabel}` : "Undo"}</span>
        </button>
        <button className="warn" disabled={!team || paused} title="Skip this team (no sale)"
          onClick={() => { if (confirm("Skip this team (no sale)?")) act("skipTeam").then(surface); }}>Skip</button>
        <button className={paused ? "go" : ""} title={paused ? "Resume the draft" : "Pause the draft on every device"}
          onClick={() => act("setPaused", { paused: !paused }).then(surface)}>
          {paused ? "▶" : "⏸"}<span className="lbl"> {paused ? "Resume" : "Pause"}</span>
        </button>
      </div>
    </div>
  );
}

function GroupsPanel({ view }) {
  const { state, summaries } = view;
  const { sales } = state.auction;
  return (
    <div className="gpanel">
      {state.config.groups.map(g => {
        const s = summaries[g.id];
        const owned = Object.entries(sales)
          .filter(([, x]) => x.group === g.id)
          .sort((a, b) => b[1].amount - a[1].amount);
        const ours = g.id === state.config.ourGroupId;
        return (
          <div key={g.id} className={"gcard" + (ours ? " ours" : "")}>
            <div className="gavatars">
              {membersOf(g.name).map(n => (
                <Avatar key={n} name={n} title={n} size={ours ? 32 : 20} mode={ours ? "hero" : "weak"} />
              ))}
            </div>
            <div className="gname">{memberNames(g.name)}</div>
            {owned.map(([t, x]) => (
              <div key={t} className="gteam">
                <span><img className="tinylogo" src={logo(t)} alt="" /> {moji(t)} {t}</span>
                <b>{fmt$(x.amount)}</b>
              </div>
            ))}
            {!owned.length && <div className="gteam"><span className="dim">no teams yet</span></div>}
            <div className="gtotal">
              <span className="dim">spent <b>{fmt$(s.spent)}</b></span>
              <b className={s.remaining < 500 ? "red" : "green"}>{fmt$(s.remaining)} left</b>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QuickPick({ view }) {
  const { state, teams, repricing } = view;
  const unsold = Object.keys(teams)
    .filter(t => !state.auction.sales[t])
    .sort((a, b) => (repricing.fair[b] || 0) - (repricing.fair[a] || 0));
  if (!unsold.length) return null;
  return (
    <div className="speech">
      <select value="" onChange={e => { if (e.target.value) act("blockTeam", { team: e.target.value }); }}>
        <option value="">put a team on the block…</option>
        {unsold.map(t => <option key={t} value={t}>{moji(t)} {teams[t].name} — {fmt$(repricing.fair[t] || 0)}</option>)}
      </select>
    </div>
  );
}

function BestRemaining({ view, title }) {
  const { state, repricing } = view;
  const { sales, skipped, onBlock } = state.auction;
  const remaining = Object.keys(view.teams)
    .filter(t => !sales[t] && t !== onBlock)
    .sort((a, b) => (repricing.fair[b] || 0) - (repricing.fair[a] || 0))
    .slice(0, 6);
  if (!remaining.length) return null;
  return (
    <div className="upnext">
      <h3>{title}</h3>
      <div className="strip">
        {remaining.map(t => {
          // Tap-to-block only while the block is empty and the draft isn't paused.
          const canBlock = state.auction.phase === "live" && !onBlock && !state.auction.paused;
          return (
            <div key={t} className={"mini" + (canBlock ? " clickable" : "")}
              onClick={() => canBlock && act("blockTeam", { team: t }).then(r => { if (r?.error) alert(r.error); })}>
              <img src={logo(t)} alt="" /><span>{moji(t)} {t}</span><em>{fmt$(repricing.fair[t] || 0)}</em>
              {skipped.includes(t) && <em className="amber">skipped</em>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SoldTicker({ view }) {
  const { state, teams, repricing } = view;
  const sales = Object.entries(state.auction.sales)
    .sort((a, b) => b[1].ts.localeCompare(a[1].ts)).slice(0, 8);
  if (!sales.length) return null;
  return (
    <div className="upnext">
      <h3>Sold</h3>
      {sales.map(([t, s]) => {
        const fair = repricing.fair[t] || 0;
        const d = s.amount - fair;
        return (
          <div key={t} className="soldline">
            <img src={logo(t)} alt="" />
            <span>{moji(t)} {teams[t].name}</span>
            <b>{fmt$(s.amount)}</b>
            <em className={d <= 0 ? "green" : "red"}>{d <= 0 ? "" : "+"}{fmt$(d)} vs fair</em>
            <span className="dim">{shortName(groupName(view.state.config, s.group))}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- BOARD (every price editable here) ----------------
function Board({ view }) {
  const { state, teams, valuation, repricing } = view;
  const { sales, onBlock, phase } = state.auction;
  const [editing, setEditing] = useState(null);
  const [editAmt, setEditAmt] = useState("");
  const [editGroup, setEditGroup] = useState("");
  const rows = Object.keys(teams)
    .map(t => ({ t, share: valuation?.teams?.[t]?.share ?? 0, fair: repricing.fair[t] || 0, sale: sales[t] }))
    .sort((a, b) => b.share - a.share);
  const unsoldValue = rows.filter(r => !r.sale).reduce((s, r) => s + r.fair, 0);

  const startEdit = r => {
    setEditing(r.t);
    setEditAmt(String(r.sale.amount));
    setEditGroup(r.sale.group);
  };

  return (
    <div className="pad">
      <div className="statline">
        <span>value left on board: <b>{fmt$(unsoldValue)}</b></span>
        <span>sold: <b>{Object.keys(sales).length}/32</b></span>
      </div>
      <table className="tbl">
        <thead><tr><th>Team</th><th className="r">Share</th><th className="r">Fair</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const isOnBlock = phase === "live" && onBlock === r.t;
            const d = r.sale ? r.sale.amount - r.fair : 0;
            return (
              <React.Fragment key={r.t}>
                <tr className={isOnBlock ? "hl" : ""}>
                  <td><img className="tinylogo" src={logo(r.t)} alt="" /> {moji(r.t)} {teams[r.t].name}</td>
                  <td className="r">{r.share.toFixed(2)}%</td>
                  <td className="r">{fmt$(r.fair)}</td>
                  <td>
                    {r.sale ? (
                      <span>
                        {fmt$(r.sale.amount)} → {shortName(groupName(state.config, r.sale.group))}{" "}
                        <em className={d <= 0 ? "green" : "red"}>({d <= 0 ? "" : "+"}{Math.round(d)})</em>{" "}
                        <button className="tiny" onClick={() => (editing === r.t ? setEditing(null) : startEdit(r))}>✎</button>
                      </span>
                    ) : isOnBlock ? (
                      <b className="amber">ON THE BLOCK</b>
                    ) : (
                      <span className="row" style={{ gap: ".4rem" }}>
                        <span className="dim">—</span>
                        {phase === "live" && <button className="tiny" title="Put on the block now" onClick={() => act("blockTeam", { team: r.t }).then(res => { if (res?.error) alert(res.error); })}>▶ block</button>}
                      </span>
                    )}
                  </td>
                </tr>
                {editing === r.t && r.sale && (
                  <tr className="editrow">
                    <td colSpan="4">
                      <div className="row gap">
                        <label className="dim">Price <input type="number" step="25" value={editAmt} onChange={e => setEditAmt(e.target.value)} style={{ width: 90 }} /></label>
                        <label className="dim">Owner{" "}
                          <select value={editGroup} onChange={e => setEditGroup(e.target.value)}>
                            {state.config.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        </label>
                        <button className="go" onClick={() => { act("editSale", { team: r.t, amount: Number(editAmt), group: editGroup }); setEditing(null); }}>Save</button>
                        {!view.seasonStarted && <button className="warn" onClick={() => { if (confirm(`Reopen ${teams[r.t].name}? This deletes its sale + bids.`)) { act("reopenTeam", { team: r.t }); setEditing(null); } }}>Reopen</button>}
                        <button onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- ODDS (market lines + model + likely matchups) ----------------
const american = o => (o == null ? "—" : o > 0 ? `+${o}` : `${o}`);
const pct = p => `${Math.round(p * 100)}%`;
const pct1 = p => `${(p * 100).toFixed(1)}%`;

function Odds({ view }) {
  const { teams, valuation, repricing } = view;
  const inSeason = !!view.seasonStarted || view.state.auction.phase === "done";
  const money = t => inSeason ? ((valuation.teams[t]?.share || 0) / 100) * view.potForSettlement : (repricing.fair[t] || 0);
  if (!valuation?.teams || !Object.values(valuation.teams)[0]?.market)
    return <div className="pad"><p className="dim">Market blend still computing — refresh in a minute.</p></div>;
  const rows = Object.keys(teams)
    .map(t => ({ t, v: valuation.teams[t] }))
    .filter(r => r.v)
    .sort((a, b) => b.v.share - a.v.share);
  const wPct = Math.round((valuation.marketWeight || 0) * 100);
  const disagree = v => {
    const dPl = Math.abs((v.market.pPlayoff ?? 0) - (v.sim.pPlayoff ?? 0));
    const ratio = v.sim.pSb > 5e-3 ? v.market.pSb / v.sim.pSb : 1;
    return dPl >= 0.12 || ratio >= 1.8 || ratio <= 0.55;
  };
  const ROUNDS = [["wc", "Wild Card"], ["div", "Divisional"], ["conf", "Conference Championships"], ["sb", "Super Bowl"]];
  return (
    <div className="pad">
      <p className="dim">
        Sportsbook futures (de-vigged) blended into the season simulation at <b>{wPct}% market weight</b>. The weight shrinks as
        real games are played, so by December the numbers run almost entirely on actual results. ⚡ = sportsbooks and the model disagree.
      </p>
      <div className="tablewrap"><table className="tbl">
        <thead><tr>
          <th>Team</th><th className="r">O/U</th><th className="r">E[W]</th>
          <th className="r">Playoffs</th><th className="r">Division</th><th className="r">Super Bowl</th><th className="r">{inSeason ? "Proj. $" : "Fair"}</th>
        </tr></thead>
        <tbody>
          {rows.map(({ t, v }) => (
            <tr key={t}>
              <td><img className="tinylogo" src={logo(t)} alt="" /> {moji(t)} {teams[t].name} {disagree(v) && <em className="amber" title={`market P(playoffs) ${pct(v.market.pPlayoff)} vs model ${pct(v.sim.pPlayoff)}; market P(SB) ${pct1(v.market.pSb)} vs model ${pct1(v.sim.pSb)}`}>⚡</em>}</td>
              <td className="r">{v.market.winTotal ?? "—"}</td>
              <td className="r">{(v.expWinsView ?? v.expWins).toFixed(1)}</td>
              <td className="r">{pct(v.pPlayoffs)}<div className="subodds">{american(v.market.playoffOdds)} · sim {pct(v.sim.pPlayoff)}</div></td>
              <td className="r">{pct(v.pDivTitle)}<div className="subodds">{american(v.market.divisionOdds)}</div></td>
              <td className="r">{pct1(v.pSbWin)}<div className="subodds">{american(v.market.sbOdds)} · sim {pct1(v.sim.pSb)}</div></td>
              <td className="r"><b>{fmt$(money(t))}</b></td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <h2>🔮 Most likely playoff matchups</h2>
      <p className="dim">From {""}the simulated seasons — how often each pairing occurs (home team second, seeds decide home field).</p>
      {ROUNDS.map(([key, label]) => (
        <div key={key} className="upnext">
          <h3>{label}</h3>
          <div className="strip">
            {(valuation.matchups?.[key] || []).map((m, i) => (
              <div key={i} className="matchchip">
                <img src={logo(m.away)} alt="" />
                <span>{key === "sb" ? "vs" : "@"}</span>
                <img src={logo(m.home)} alt="" />
                <em>{Math.round(m.p * 100)}%</em>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="dim" style={{ marginTop: "1rem" }}>
        Super Bowl, conference, and division futures refresh automatically every day from ESPN's public feed
        ({view.oddsMeta?.provider || "DraftKings"} prices{view.oddsMeta?.fetchedAt ? `, last ${new Date(view.oddsMeta.fetchedAt).toLocaleString()}` : ""}{view.oddsMeta?.ageDays > 1 ? `, ${view.oddsMeta.ageDays} days old` : ""}).{view.oddsMeta?.error ? ` ⚠️ Last refresh failed (${view.oddsMeta.error}); showing the previous snapshot.` : ""}
        Win totals are the preseason prior (the in-season model runs on actual results). Make-the-playoffs prices
        aren't in the feed, so that column is derived from the division market.
      </p>
    </div>
  );
}

function TradeFinder({ view, onDraft }) {
  const { tradeFinder: tf, state, teams, oddsMeta } = view;
  if (!tf) return null;
  const config = state.config; const ours = config.ourGroupId;
  const ownerLabel = own => Object.entries(own).filter(([, p]) => p > 0).map(([g, p]) => `${shortName(groupName(config, g))}${p < 100 ? ` ${fmtPct(p)}` : ""}`).join(", ");
  const primaryOwner = own => Object.entries(own).filter(([g, p]) => p > 0 && g !== ours).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return (
    <div>
      <h2>🔎 Trade finder</h2>
      <p className="dim">Where our model (results + schedule sim) disagrees with the public view (sportsbook futures from ESPN{oddsMeta?.fetchedAt ? `, ${new Date(oddsMeta.fetchedAt).toLocaleString()}` : ""}{oddsMeta?.ageDays > 1 ? ` — ${oddsMeta.ageDays} days old` : ""}). "Offer up to" keeps a 15% edge; the counterparty will anchor near the market number.</p>
      {oddsMeta?.error && <p className="amber">⚠️ Last odds refresh failed: {oddsMeta.error} — using the previous snapshot.</p>}
      {tf.stale && <p className="amber">⏳ Buy/sell flags paused: {tf.reason}.</p>}
      <h3>Buy targets — rivals' teams our model likes more than the market</h3>
      {!tf.buy.length ? <p className="dim">Nothing worth chasing right now.</p> : (
        <div className="tablewrap"><table className="tbl">
          <thead><tr><th>Team</th><th>Seller</th><th className="r">Model value</th><th className="r">Market value</th><th className="r">Edge</th><th className="r">Offer up to</th><th className="r">Walk away</th><th></th></tr></thead>
          <tbody>{tf.buy.map(r => (
            <tr key={r.team + r.owner}>
              <td>{moji(r.team)} {teams[r.team].name}</td><td>{shortName(groupName(config, r.owner))}{r.stake < 100 ? ` (${fmtPct(r.stake)} stake)` : ""}</td>
              <td className="r">{fmt$(r.modelFuture)}</td><td className="r">{fmt$(r.marketFuture)}</td>
              <td className="r green">+{fmt$(r.edge)}</td><td className="r"><b>{fmt$(r.offerUpTo)}</b></td><td className="r">{fmt$(r.walkAway)}</td>
              <td><button className="tiny" onClick={() => onDraft({ team: r.team, from: r.owner, to: ours, pct: r.stake, cash: Math.round(r.offerUpTo / 25) * 25 })}>draft offer</button></td>
            </tr>))}</tbody>
        </table></div>
      )}
      <h3>Sell candidates — our teams the market likes more than our model</h3>
      {!tf.sell.length ? <p className="dim">Nothing to shop.</p> : (
        <div className="tablewrap"><table className="tbl">
          <thead><tr><th>Team</th><th className="r">Our stake</th><th className="r">Model value</th><th className="r">Market value</th><th className="r">Ask at least</th><th className="r">Floor</th></tr></thead>
          <tbody>{tf.sell.map(r => (
            <tr key={r.team}>
              <td>{moji(r.team)} {teams[r.team].name}</td><td className="r">{fmtPct(r.ourStake)}</td>
              <td className="r">{fmt$(r.modelFuture)}</td><td className="r">{fmt$(r.marketFuture)}</td>
              <td className="r"><b>{fmt$(r.askAtLeast)}</b></td><td className="r">{fmt$(r.floor)}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <details className="upnext"><summary><h3 style={{ display: "inline" }}>All 32 — model vs market remaining value</h3></summary>
        <div className="tablewrap"><table className="tbl">
          <thead><tr><th>Team</th><th>Owner</th><th className="r">Banked</th><th className="r">Model</th><th className="r">Market</th><th className="r">Edge</th></tr></thead>
          <tbody>{tf.all.map(r => (
            <tr key={r.team} className={r.ourStake > 0 ? "hl" : ""}>
              <td>{moji(r.team)} {r.team}{r.eliminated ? " ✖" : ""}</td><td>{ownerLabel(r.owners)}</td>
              <td className="r">{fmt$(r.banked$)}</td><td className="r">{fmt$(r.modelFuture)}</td><td className="r">{fmt$(r.marketFuture)}</td>
              <td className={"r " + (r.edge >= 0 ? "green" : "red")}>{r.edge >= 0 ? "+" : ""}{fmt$(r.edge)}</td>
            </tr>))}</tbody>
        </table></div>
      </details>
    </div>
  );
}

// ---------------- TRADES ----------------
function Trades({ view }) {
  const { state, teams, valuation, earnedByTeam, potForSettlement } = view;
  const soldTeams = Object.keys(state.auction.sales);
  const [form, setForm] = useState({ team: "", from: "", to: "", pct: 50, cash: 0 });
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);
  const owners = useMemo(() => {
    if (!form.team) return [];
    const sale = state.auction.sales[form.team];
    const own = { [sale.group]: 100 };
    for (const tr of state.trades.filter(t => t.team === form.team)) {
      own[tr.from] = (own[tr.from] || 0) - tr.pct;
      own[tr.to] = (own[tr.to] || 0) + tr.pct;
    }
    return Object.entries(own).filter(([, p]) => p > 0);
  }, [form.team, state]);

  const remainingShare = form.team && valuation?.teams?.[form.team]
    ? Math.max(0, valuation.teams[form.team].share - (earnedByTeam[form.team] || 0))
    : 0;
  const sliceFair = (form.pct / 100) * (remainingShare / 100) * potForSettlement;

  return (
    <div className="pad">
      <TradeFinder view={view} onDraft={o => setForm(o)} />
      <h2>🤝 Trade desk</h2>
      {!soldTeams.length ? <p className="dim">Trades open once teams are sold.</p> : (
        <div className="tradeform">
          <select value={form.team} onChange={e => setForm({ ...form, team: e.target.value, from: "" })}>
            <option value="">team…</option>
            {soldTeams.map(t => <option key={t} value={t}>{moji(t)} {teams[t].name}</option>)}
          </select>
          <select value={form.from} onChange={e => setForm({ ...form, from: e.target.value })}>
            <option value="">seller…</option>
            {owners.map(([gid, pct]) => <option key={gid} value={gid}>{groupName(state.config, gid)} (owns {fmtPct(pct)})</option>)}
          </select>
          <select value={form.to} onChange={e => setForm({ ...form, to: e.target.value })}>
            <option value="">buyer…</option>
            {state.config.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <label>Stake %<input type="number" min="1" max="100" value={form.pct} onChange={e => setForm({ ...form, pct: Number(e.target.value) })} /></label>
          <label>Cash $<input type="number" min="0" step="25" value={form.cash} onChange={e => setForm({ ...form, cash: Number(e.target.value) })} /></label>
          {form.team && (
            <p className="dim">
              Model: remaining value of {form.pct}% of {teams[form.team].name} ≈ <b>{fmt$(sliceFair)}</b>{" "}
              ({remainingShare.toFixed(2)}% share left × est. pot). Buyer pays cash to seller; report to Jamie &amp; Dylan before it counts.
            </p>
          )}
          {err && <p className="red">⚠️ {err}</p>}
          <button
            className="big go"
            disabled={pending || !form.team || !form.from || !form.to || form.from === form.to || !(form.pct > 0) || form.pct > ((owners.find(([g]) => g === form.from)?.[1]) ?? 0)}
            onClick={async () => {
              setPending(true); setErr(null);
              const r = await act("addTrade", form);
              setPending(false);
              if (r?.error) setErr(r.error); else setForm({ team: "", from: "", to: "", pct: 50, cash: 0 });
            }}
          >{pending ? "Recording…" : "Record trade"}</button>
          {form.from && form.pct > ((owners.find(([g]) => g === form.from)?.[1]) ?? 0) && (
            <p className="dim">Seller only owns {fmtPct((owners.find(([g]) => g === form.from)?.[1]) ?? 0)} of this team.</p>
          )}
        </div>
      )}
      <h3>Ledger</h3>
      {state.trades.map(tr => (
        <div key={tr.id} className="soldline">
          <img src={logo(tr.team)} alt="" />
          <span>{tr.pct}% {teams[tr.team].name}: {shortName(groupName(state.config, tr.from))} → {shortName(groupName(state.config, tr.to))}</span>
          <b>{fmt$(tr.cash)}</b>
          <em className="dim">{new Date(tr.ts).toLocaleDateString()}</em>
          <button onClick={() => act("deleteTrade", { id: tr.id })}>✕</button>
        </div>
      ))}
      {!state.trades.length && <p className="dim">No trades yet.</p>}
    </div>
  );
}

// ---------------- SETUP ----------------
function Setup({ view }) {
  const { state } = view;
  const [groups, setGroups] = useState(state.config.groups);
  const [dirty, setDirty] = useState(false);
  // A broadcast from any device re-syncs the form — but never while there are unsaved edits.
  useEffect(() => { if (!dirty) setGroups(state.config.groups); }, [state.config.groups, dirty]);
  const edit = next => { setDirty(true); setGroups(next); };

  return (
    <div className="pad setup">
      <h2>Groups</h2>
      <p className="dim">Aliases = names the listener should recognize as that group ("joon, gunther, dave"). Comma-separated.</p>
      {groups.map((g, i) => (
        <div key={g.id} className="grouprow">
          <div className="row gap">
            <input value={g.name} placeholder="group name" onChange={e => edit(groups.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input type="number" step="500" value={g.budget} style={{ width: 90 }}
              onChange={e => edit(groups.map((x, j) => j === i ? { ...x, budget: Number(e.target.value) } : x))} />
            <button onClick={() => edit(groups.filter((_, j) => j !== i))}>✕</button>
          </div>
          <input value={g.aliases || ""} placeholder="aliases (member names)"
            onChange={e => edit(groups.map((x, j) => j === i ? { ...x, aliases: e.target.value } : x))} />
        </div>
      ))}
      <div className="row gap">
        <button onClick={() => edit([...groups, { id: `g${Date.now()}`, name: `Group ${groups.length + 1}`, budget: 7000, aliases: "" }])}>+ group</button>
        <button className="go" onClick={() => act("setGroups", { groups }).then(() => setDirty(false))}>Save groups{dirty ? " •" : ""}</button>
        {dirty && <button onClick={() => { setDirty(false); setGroups(state.config.groups); }}>Discard edits</button>}
      </div>

      <h2>Our group</h2>
      <select value={state.config.ourGroupId} onChange={e => act("setOurGroup", { groupId: e.target.value })}>
        {state.config.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>

      <h2>Scoring profile</h2>
      <p className="dim">Which payout rules every valuation and fair price is computed against. Switching re-runs the whole simulation (~30s).</p>
      <select value={view.scoringProfile?.active} onChange={e => act("setScoringProfile", { profile: e.target.value })}>
        {Object.entries(view.scoringProfile?.options || {}).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>

      <h2>Pot & discipline</h2>
      <label>Prior pot guess $
        <input type="number" step="1000" defaultValue={state.config.priorPot} onBlur={e => act("setPriorPot", { pot: e.target.value })} />
      </label>
      <label>Target margin (bid up to fair × this)
        <input type="number" step="0.05" min="0.3" max="1.5" defaultValue={state.config.targetMargin} onBlur={e => act("setTargetMargin", { margin: e.target.value })} />
      </label>

      <h2>Danger zone</h2>
      <button className="warn" onClick={() => { if (confirm("Reset the entire auction and all trades?")) act("resetAuction"); }}>
        Reset auction + trades
      </button>
    </div>
  );
}
