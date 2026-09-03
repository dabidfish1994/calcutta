import React, { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, membersOf } from "./avatars.jsx";

const fmt$ = n => "$" + Math.round(n).toLocaleString();
const logo = abbr => `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;

// Every team gets a mascot. Non-negotiable.
const MOJI = {
  BUF: "🦬", MIA: "🐬", NE: "🎩", NYJ: "✈️", BAL: "🐦‍⬛", CIN: "🐅", CLE: "🐶", PIT: "🛠️",
  HOU: "🤠", IND: "🐴", JAX: "🐆", TEN: "⚔️", DEN: "🐎", KC: "🏹", LV: "🎰", LAC: "⚡",
  DAL: "⭐", NYG: "🗽", PHI: "🦅", WSH: "🎖️", CHI: "🐻", DET: "🦁", GB: "🧀", MIN: "🪓",
  ATL: "🐦", NO: "⚜️", TB: "🏴‍☠️", CAR: "🐈‍⬛", ARI: "🌵", LAR: "🐏", SF: "⛏️", SEA: "🌊"
};
const moji = t => MOJI[t] || "🏈";

async function act(type, payload = {}) {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, ...payload })
  });
  return res.json();
}

function useLive(onTranscript) {
  const [view, setView] = useState(null);
  const cbRef = useRef(onTranscript);
  cbRef.current = onTranscript;
  useEffect(() => {
    let ws, closed = false, retry;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === "view") setView(msg.data);
        if (msg.type === "transcript") cbRef.current?.(msg.line);
      };
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 1500); };
    };
    connect();
    fetch("/api/view").then(r => r.json()).then(setView).catch(() => {});
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, []);
  return view;
}

const TABS = ["Draft", "Board", "Odds", "Season", "Trades", "Setup"];
const TAB_MOJI = { Draft: "🔨", Board: "📋", Odds: "🎲", Season: "🏈", Trades: "🤝", Setup: "⚙️" };

export default function App() {
  const [tabSel, setTab] = useState(null);
  const [lines, setLines] = useState([]);
  const view = useLive(line => setLines(l => [...l.slice(-79), line]));
  useEffect(() => {
    fetch("/api/transcript").then(r => r.json()).then(d => setLines(d.lines || [])).catch(() => {});
  }, []);
  if (!view) return <div className="loading">🏈 Connecting to the war room…</div>;
  const tab = tabSel ?? (view.state.auction.phase === "done" ? "Season" : "Draft");
  const Comp = { Draft, Board, Odds, Season, Trades, Setup }[tab];
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          🏈 Cardinal War Room
          <span className="crew">
            {membersOf(view.state.config.groups.find(g => g.id === view.state.config.ourGroupId)?.name).map(n => (
              <Avatar key={n} name={n} title={n} size={22} mode="hero" />
            ))}
          </span>
        </span>
        <PotBadge view={view} />
      </header>
      <main><Comp view={view} lines={lines} /></main>
      <nav className="tabs">
        {TABS.map(t => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
            <span className="tabmoji">{TAB_MOJI[t]}</span> {t}
          </button>
        ))}
      </nav>
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

      <SpeechPanel onFinal={handleFinal} autoStart={auction.phase === "live"} />
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

function shortName(name) {
  if (!name) return "?";
  const first = name.split(/[\s(/]+/)[0];
  return first.length > 8 ? first.slice(0, 8) : first;
}
// "Us (Fish/Joon/Gunther)" -> "Fish · Joon · Gunther"; "Mark/Fuller" -> "Mark · Fuller"
function memberNames(name) {
  if (!name) return "?";
  const m = name.match(/\(([^)]+)\)/);
  const core = m ? m[1] : name;
  const parts = core.split(/[/,+&]+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts.join(" · ") : name;
}
const groupName = (config, id) => config.groups.find(g => g.id === id)?.name || id;

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
                        <button className="warn" onClick={() => { if (confirm(`Reopen ${teams[r.t].name}? This deletes its sale + bids.`)) { act("reopenTeam", { team: r.t }); setEditing(null); } }}>Reopen</button>
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
        Priced under: <b>{view.scoringProfile?.label}</b>. Sportsbook futures (de-vigged) blended into the
        sim at <b>{wPct}% market weight</b> — the weight decays automatically as real games are played.
        ⚡ = market and model disagree; that's where auction edges live.
      </p>
      <div className="tablewrap"><table className="tbl">
        <thead><tr>
          <th>Team</th><th className="r">O/U</th><th className="r">E[W]</th>
          <th className="r">Playoffs</th><th className="r">Division</th><th className="r">Super Bowl</th><th className="r">Fair</th>
        </tr></thead>
        <tbody>
          {rows.map(({ t, v }) => (
            <tr key={t}>
              <td><img className="tinylogo" src={logo(t)} alt="" /> {moji(t)} {teams[t].name} {disagree(v) && <em className="amber" title={`market P(playoffs) ${pct(v.market.pPlayoff)} vs model ${pct(v.sim.pPlayoff)}; market P(SB) ${pct1(v.market.pSb)} vs model ${pct1(v.sim.pSb)}`}>⚡</em>}</td>
              <td className="r">{v.market.winTotal ?? "—"}</td>
              <td className="r">{v.expWins.toFixed(1)}</td>
              <td className="r">{pct(v.pPlayoffs)}<div className="subodds">{american(v.market.playoffOdds)} · sim {pct(v.sim.pPlayoff)}</div></td>
              <td className="r">{pct(v.pDivTitle)}<div className="subodds">{american(v.market.divisionOdds)}</div></td>
              <td className="r">{pct1(v.pSbWin)}<div className="subodds">{american(v.market.sbOdds)} · sim {pct1(v.sim.pSb)}</div></td>
              <td className="r"><b>{fmt$(repricing.fair[t] || 0)}</b></td>
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
        Lines: consensus win totals (FOX/Yahoo), Super Bowl futures (ESPN, Aug 16), make-the-playoffs (Yahoo),
        division winners (Jul 25). Edit <code>data/market-odds-2026.json</code> to refresh; the engine de-vigs
        and re-blends on the next sync.
      </p>
    </div>
  );
}

// ---------------- SEASON (week-by-week tracker) ----------------
const kickoff = iso => new Date(iso).toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });

function OwnerTags({ own, config }) {
  const entries = Object.entries(own || {}).filter(([, p]) => p > 0);
  if (!entries.length) return <span className="otag none">unowned</span>;
  return <>{entries.map(([gid, p]) => (
    <span key={gid} className={"otag" + (gid === config.ourGroupId ? " ours" : "")}>
      {shortName(groupName(config, gid))}{p < 100 ? ` ${p}%` : ""}
    </span>
  ))}</>;
}

function Season({ view }) {
  const { state, teams, summaries, projections, season, earnedByTeam, potForSettlement, scheduleFetchedAt, valuation } = view;
  const [syncing, setSyncing] = useState(false);
  const [wkSel, setWkSel] = useState(null);
  const config = state.config;
  const ours = config.ourGroupId;
  const pot = potForSettlement;
  const weeks = season?.weeks || [];
  const curKey = wkSel || season?.currentWeek || weeks[0]?.key;
  const week = weeks.find(w => w.key === curKey);
  const proj = projections?.groups || {};
  const groups = [...config.groups].sort((a, b) => (proj[b.id]?.projectedNet ?? 0) - (proj[a.id]?.projectedNet ?? 0));
  const weekEarned = gid => season?.byGroupWeek?.[gid]?.[curKey] || 0;
  const rec = t => { const r = season?.teamRecord?.[t]; return r ? `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}` : "0-0"; };

  if (state.auction.phase !== "done")
    return <div className="pad"><p className="dim">Season tracking starts once the draft is complete.</p></div>;

  return (
    <div className="pad">
      <div className="statline">
        <span>pot <b>{fmt$(pot)}</b> · {season?.currentWeek ? `now: ${week?.label}` : ""}</span>
        <button disabled={syncing} onClick={async () => { setSyncing(true); await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }); setSyncing(false); }}>
          {syncing ? "Syncing…" : "Sync scores now"}
        </button>
      </div>
      <p className="dim">Scores sync from ESPN every hour (last pull {scheduleFetchedAt ? new Date(scheduleFetchedAt).toLocaleString() : "—"}). Projected = banked so far + the engine's re-simulated remaining season, re-fit to real results.</p>

      <h2>🏆 Standings</h2>
      <div className="tablewrap"><table className="tbl">
        <thead><tr><th>Group</th><th className="r">Teams</th><th className="r">Banked</th><th className="r">Projected</th><th className="r">Spent</th><th className="r">Proj. net</th><th className="r">{week?.label || "Week"}</th></tr></thead>
        <tbody>
          {groups.map(g => {
            const s = summaries[g.id]; const pj = proj[g.id] || {};
            return (
              <tr key={g.id} className={g.id === ours ? "hl" : ""}>
                <td>{memberNames(g.name)}</td>
                <td className="r">{s.teams.length}</td>
                <td className="r">{fmt$(s.earnedDollars)}</td>
                <td className="r">{fmt$(pj.projectedEarned || 0)}</td>
                <td className="r">{fmt$(s.spent)}</td>
                <td className={"r " + ((pj.projectedNet || 0) >= 0 ? "green" : "red")}><b>{(pj.projectedNet || 0) >= 0 ? "+" : ""}{fmt$(pj.projectedNet || 0)}</b></td>
                <td className="r">{weekEarned(g.id) ? fmt$(weekEarned(g.id)) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>

      <h2>🧢 Our teams</h2>
      <div className="spots">
        {(summaries[ours]?.teams || []).sort((a, b) => (valuation?.teams?.[b]?.share || 0) - (valuation?.teams?.[a]?.share || 0)).map(t => {
          const pt = projections?.teams?.[t] || {};
          const banked = ((earnedByTeam[t] || 0) / 100) * pot;
          const projected = ((pt.totalShare || 0) / 100) * pot;
          const paid = state.auction.sales[t]?.amount || 0;
          return (
            <div key={t} className="spot">
              <div className="spothead"><img src={logo(t)} alt="" /><div><b>{moji(t)} {teams[t].name}</b><div className="dim">{rec(t)} · paid {fmt$(paid)}</div></div></div>
              <div className="spotnums">
                <div><label>banked</label><b>{fmt$(banked)}</b></div>
                <div><label>projected</label><b>{fmt$(projected)}</b></div>
                <div><label>vs paid</label><b className={projected - paid >= 0 ? "green" : "red"}>{projected - paid >= 0 ? "+" : ""}{fmt$(projected - paid)}</b></div>
              </div>
            </div>
          );
        })}
      </div>

      <h2>📅 Week by week</h2>
      <div className="weeknav">
        {weeks.map(w => (
          <button key={w.key} className={(w.key === curKey ? "on" : "") + (w.key === season?.currentWeek ? " now" : "")} onClick={() => setWkSel(w.key)}>{w.label}</button>
        ))}
      </div>
      {week && (
        <div className="games">
          {week.games.map(g => (
            <div key={g.id} className={"game" + (g.final ? " final" : "")}>
              <div className={"side" + (g.winner === g.away ? " won" : "")}>
                <img src={logo(g.away)} alt="" /><span className="abbr">{moji(g.away)} {g.away}</span>
                <span className="owners"><OwnerTags own={g.awayOwners} config={config} /></span>
                {g.final && <b className="score">{g.awayScore}</b>}
              </div>
              <div className="mid">{g.final ? "F" : kickoff(g.date)}</div>
              <div className={"side home" + (g.winner === g.home ? " won" : "")}>
                {g.final && <b className="score">{g.homeScore}</b>}
                <span className="owners"><OwnerTags own={g.homeOwners} config={config} /></span>
                <span className="abbr">{g.home} {moji(g.home)}</span><img src={logo(g.home)} alt="" />
              </div>
              {g.final && g.winner && g.credit > 0 && (
                <div className="credit">+{fmt$((g.credit / 100) * pot)} → <OwnerTags own={g.winner === g.home ? g.homeOwners : g.awayOwners} config={config} /></div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- TRADES ----------------
function Trades({ view }) {
  const { state, teams, valuation, earnedByTeam, potForSettlement } = view;
  const soldTeams = Object.keys(state.auction.sales);
  const [form, setForm] = useState({ team: "", from: "", to: "", pct: 50, cash: 0 });
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
      <h2>🤝 Trade desk</h2>
      {!soldTeams.length ? <p className="dim">Trades open once teams are sold.</p> : (
        <div className="tradeform">
          <select value={form.team} onChange={e => setForm({ ...form, team: e.target.value, from: "" })}>
            <option value="">team…</option>
            {soldTeams.map(t => <option key={t} value={t}>{moji(t)} {teams[t].name}</option>)}
          </select>
          <select value={form.from} onChange={e => setForm({ ...form, from: e.target.value })}>
            <option value="">seller…</option>
            {owners.map(([gid, pct]) => <option key={gid} value={gid}>{groupName(state.config, gid)} (owns {pct}%)</option>)}
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
          <button
            className="big go"
            disabled={!form.team || !form.from || !form.to || form.from === form.to || form.pct < 1}
            onClick={() => { act("addTrade", form); setForm({ team: "", from: "", to: "", pct: 50, cash: 0 }); }}
          >Record trade</button>
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
