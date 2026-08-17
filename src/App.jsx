import React, { useEffect, useMemo, useRef, useState } from "react";

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

const TABS = ["Draft", "Board", "Season", "Trades", "Setup"];
const TAB_MOJI = { Draft: "🔨", Board: "📋", Season: "🏈", Trades: "🤝", Setup: "⚙️" };

export default function App() {
  const [tab, setTab] = useState("Draft");
  const [lines, setLines] = useState([]);
  const view = useLive(line => setLines(l => [...l.slice(-79), line]));
  useEffect(() => {
    fetch("/api/transcript").then(r => r.json()).then(d => setLines(d.lines || [])).catch(() => {});
  }, []);
  if (!view) return <div className="loading">🏈 Connecting to the war room…</div>;
  const Comp = { Draft, Board, Season, Trades, Setup }[tab];
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🏈 Cardinal War Room</span>
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
// Handles absolutes ("350", "three fifty", "seven hundred", "$425", "twelve fifty")
// and relative raises ("twenty five more", "bump it fifty", "another hundred").
export function extractAmounts(text, topBid = 0) {
  const raw = [];
  for (const m of text.matchAll(/\$?\b([1-9]\d{1,3})\b/g)) raw.push(Number(m[1]));
  const toks = text.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(t => t && t !== "and");
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
    }
    if (val >= 25) { raw.push(val); i = j - 1; }
  }
  const relative = REL_RE.test(text) && topBid > 0;
  const out = new Set();
  for (let v of raw) {
    v = Math.round(v / 25) * 25;
    if (v >= 50 && v > topBid) out.add(v);           // a normal raise, spoken absolutely
    else if (relative && v >= 25 && v <= 1000) out.add(topBid + v); // "fifty more" on top of the bid
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

function SpeechPanel({ onFinal }) {
  const [listening, setListening] = useState(false);
  const [line, setLine] = useState("");
  const [supported] = useState(() => !!(window.SpeechRecognition || window.webkitSpeechRecognition));
  const recRef = useRef(null);

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

  if (!supported) return <p className="dim">Speech recognition needs Chrome or Safari.</p>;
  return (
    <div className="speech">
      <button className={listening ? "on" : ""} onClick={() => (listening ? stop() : start())}>
        {listening ? "🎙 Listening…" : "🎙 Listen for bids"}
      </button>
      {listening && <span className="dim transcript">{line || "…"}</span>}
    </div>
  );
}

function TranscriptLog({ lines, teams }) {
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
  const dedupe = useRef({ amount: 0, ts: 0, sold: 0 });

  const team = auction.order[auction.current];
  useEffect(() => { setSuggestion(null); setCustomAmt(null); }, [team]);

  const bidsOnTeam = auction.bids.filter(b => b.team === team);
  const top = bidsOnTeam[bidsOnTeam.length - 1];
  const topRef = useRef(top);
  topRef.current = top;

  const handleFinal = txt => {
    const topAmt = topRef.current?.amount || 0;
    const amounts = extractAmounts(txt, topAmt);
    const group = matchGroup(txt, config.groups);
    fetch("/api/transcript", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: txt, amounts, group })
    }).catch(() => {});
    const now = Date.now();
    if (/\bsold\b/i.test(txt) && now - dedupe.current.sold > 6000) {
      dedupe.current.sold = now;
      setSuggestion({ kind: "sold", heard: txt });
      return;
    }
    if (amounts.length) {
      const amount = Math.max(...amounts);
      if (amount === dedupe.current.amount && now - dedupe.current.ts < 8000) return;
      dedupe.current = { ...dedupe.current, amount, ts: now };
      setSuggestion({ kind: "bid", amount, group, heard: txt });
    }
  };

  if (auction.phase === "setup")
    return (
      <div className="pad">
        <h2>Pre-flight</h2>
        <p>Set your groups and pot guess in <b>Setup</b>, then start. The order can be shuffled here or entered to match the commissioners' draw.</p>
        <div className="row gap">
          <button className="big go" onClick={() => act("startAuction")}>Start auction</button>
          <button className="big" onClick={() => act("shuffleOrder")}>Shuffle order</button>
        </div>
        {!valuation && <p className="dim">Valuations are computing from the live schedule + win totals…</p>}
        <OrderPreview view={view} />
      </div>
    );

  if (auction.phase === "done" || !team)
    return (
      <div className="pad">
        <h2>Auction complete</h2>
        <p>Head to <b>Board</b> (prices stay editable there) and <b>Season</b>.</p>
        <TranscriptLog lines={lines} teams={teams} />
      </div>
    );

  const v = valuation?.teams?.[team];
  const fair = repricing.fair[team] || 0;
  const target = fair * config.targetMargin;
  const nextBid = top ? top.amount + (top.amount < 500 ? 25 : 50) : 50;
  const bidAmt = customAmt ?? nextBid;
  const status = !top ? "open" : top.amount <= target ? "green" : top.amount <= fair ? "amber" : "red";

  return (
    <div className="pad draft">
      <div className="budgets">
        {config.groups.map(g => {
          const s = summaries[g.id];
          const ours = g.id === config.ourGroupId;
          return (
            <div key={g.id} className={"chip" + (ours ? " ours" : "")} title={g.name}>
              <span>{shortName(g.name)}</span><b>{fmt$(s.remaining)}</b>
            </div>
          );
        })}
      </div>

      <div className={"block " + status}>
        <div className="blockhead">
          <img src={logo(team)} alt="" />
          <div>
            <h1>{moji(team)} {teams[team].name}</h1>
            <span className="dim">{teams[team].conf} {teams[team].div} · #{auction.current + 1} of {auction.order.length}</span>
          </div>
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
        {status === "green" && <div className="verdict green">💎 Under target — hammer time.</div>}
        {status === "red" && <div className="verdict">🚨 Over fair — let someone else buy the trophy.</div>}
        {status === "amber" && <div className="verdict amber">🤔 At fair — only if the plan says so.</div>}
      </div>

      <SpeechPanel onFinal={handleFinal} />

      {suggestion && suggestion.kind === "bid" && (
        <div className="suggest">
          <div className="suggesthead">
            Heard <b>{fmt$(suggestion.amount)}</b>{suggestion.group ? <> from <b>{shortName(groupName(config, suggestion.group))}</b></> : " — who said it?"}
            <span className="dim transcript">“{suggestion.heard}”</span>
          </div>
          <div className="groupbtns">
            {suggestion.group && (
              <button className="go"
                disabled={summaries[suggestion.group].remaining < suggestion.amount}
                onClick={() => { act("logBid", { group: suggestion.group, amount: suggestion.amount }); setSuggestion(null); setCustomAmt(null); }}>
                ✓ Confirm {fmt$(suggestion.amount)} · {shortName(groupName(config, suggestion.group))}
              </button>
            )}
            {config.groups.filter(g => g.id !== suggestion.group).map(g => (
              <button key={g.id} className={g.id === config.ourGroupId ? "ours" : ""}
                disabled={summaries[g.id].remaining < suggestion.amount}
                onClick={() => { act("logBid", { group: g.id, amount: suggestion.amount }); setSuggestion(null); setCustomAmt(null); }}>
                {shortName(g.name)}
              </button>
            ))}
            <button onClick={() => setSuggestion(null)}>✕</button>
          </div>
        </div>
      )}
      {suggestion && suggestion.kind === "sold" && (
        <div className="suggest">
          <div className="suggesthead">
            Heard <b>SOLD</b> — confirm {top ? `${fmt$(top.amount)} to ${shortName(groupName(config, top.group))}` : "(no bid logged yet)"}?
            <span className="dim transcript">“{suggestion.heard}”</span>
          </div>
          <div className="groupbtns">
            <button className="go" disabled={!top}
              onClick={() => { act("sold"); setSuggestion(null); setCustomAmt(null); }}>Confirm sale</button>
            <button onClick={() => setSuggestion(null)}>✕</button>
          </div>
        </div>
      )}

      <div className="bidrow">
        <div className="stepper">
          <button onClick={() => setCustomAmt(Math.max(50, bidAmt - (bidAmt <= 500 ? 25 : 50)))}>−</button>
          <span onClick={() => {
            const amt = window.prompt("Bid amount:", bidAmt);
            if (amt && Number(amt) > 0) setCustomAmt(Number(amt));
          }}>{fmt$(bidAmt)}</span>
          <button onClick={() => setCustomAmt(bidAmt + (bidAmt < 500 ? 25 : 50))}>+</button>
        </div>
        <div className="groupbtns">
          {config.groups.map(g => (
            <button
              key={g.id}
              disabled={summaries[g.id].remaining < bidAmt}
              className={g.id === config.ourGroupId ? "ours" : ""}
              onClick={() => { act("logBid", { group: g.id, amount: bidAmt }); setCustomAmt(null); }}
            >
              {shortName(g.name)}
            </button>
          ))}
        </div>
      </div>

      <div className="row gap actions">
        <button className="big go" disabled={!top} onClick={() => { act("sold"); setCustomAmt(null); }}>
          🔨 SOLD {top ? `· ${fmt$(top.amount)}` : ""}
        </button>
        <button className="big" onClick={() => act("undo")}>Undo</button>
        <button className="big warn" onClick={() => { if (confirm("Skip this team (no sale)?")) act("skipTeam"); }}>Skip</button>
      </div>

      <UpNext view={view} />
      <SoldTicker view={view} />
      <TranscriptLog lines={lines} teams={teams} />
    </div>
  );
}

function shortName(name) {
  if (!name) return "?";
  const first = name.split(/[\s(/]+/)[0];
  return first.length > 8 ? first.slice(0, 8) : first;
}
const groupName = (config, id) => config.groups.find(g => g.id === id)?.name || id;

function OrderPreview({ view }) {
  const { state, repricing } = view;
  if (!state.auction.order.length) return null;
  return (
    <div className="upnext">
      <h3>Order</h3>
      <div className="strip">
        {state.auction.order.map(t => (
          <div key={t} className="mini">
            <img src={logo(t)} alt="" /><span>{t}</span><em>{fmt$(repricing.fair[t] || 0)}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function UpNext({ view }) {
  const { state, repricing } = view;
  const { order, current, sales, skipped } = state.auction;
  const upcoming = order.slice(current + 1).filter(t => !sales[t] && !skipped.includes(t)).slice(0, 6);
  if (!upcoming.length) return null;
  return (
    <div className="upnext">
      <h3>Up next</h3>
      <div className="strip">
        {upcoming.map(t => (
          <div key={t} className="mini">
            <img src={logo(t)} alt="" /><span>{moji(t)} {t}</span><em>{fmt$(repricing.fair[t] || 0)}</em>
          </div>
        ))}
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
  const { sales, order, current, phase } = state.auction;
  const [editing, setEditing] = useState(null); // team abbr
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
            const onBlock = phase === "live" && order[current] === r.t;
            const d = r.sale ? r.sale.amount - r.fair : 0;
            return (
              <React.Fragment key={r.t}>
                <tr className={onBlock ? "hl" : ""}>
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
                    ) : onBlock ? (
                      <b className="amber">ON THE BLOCK</b>
                    ) : (
                      <span className="row" style={{ gap: ".4rem" }}>
                        <span className="dim">—</span>
                        {phase === "live" && <button className="tiny" title="Put on the block now" onClick={() => act("putOnBlock", { team: r.t })}>▶ block</button>}
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

// ---------------- SEASON ----------------
function Season({ view }) {
  const { state, teams, summaries, earnedByTeam, events, potForSettlement, scheduleFetchedAt } = view;
  const [syncing, setSyncing] = useState(false);
  const groups = [...state.config.groups].sort((a, b) => (summaries[b.id]?.net ?? 0) - (summaries[a.id]?.net ?? 0));
  return (
    <div className="pad">
      <div className="statline">
        <span>settlement pot: <b>{fmt$(potForSettlement)}</b></span>
        <button disabled={syncing} onClick={async () => { setSyncing(true); await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) }); setSyncing(false); }}>
          {syncing ? "Syncing…" : "Sync scores + revalue"}
        </button>
      </div>
      <p className="dim">Scores auto-sync on server start and every 6h. Last schedule pull: {scheduleFetchedAt ? new Date(scheduleFetchedAt).toLocaleString() : "—"}. {events.length} payout events recorded.</p>
      <table className="tbl">
        <thead><tr><th>Group</th><th className="r">Earned</th><th className="r">Spent</th><th className="r">Trades</th><th className="r">Net</th></tr></thead>
        <tbody>
          {groups.map(g => {
            const s = summaries[g.id];
            return (
              <tr key={g.id} className={g.id === state.config.ourGroupId ? "hl" : ""}>
                <td>{g.name}</td>
                <td className="r">{fmt$(s.earnedDollars)} <span className="dim">({s.earnedShare.toFixed(2)}%)</span></td>
                <td className="r">{fmt$(s.spent)}</td>
                <td className="r">{s.tradeCash ? fmt$(s.tradeCash) : "—"}</td>
                <td className={"r " + (s.net >= 0 ? "green" : "red")}><b>{s.net >= 0 ? "+" : ""}{fmt$(s.net)}</b></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Earnings by team</h3>
      <div className="teamearn">
        {Object.entries(earnedByTeam).sort((a, b) => b[1] - a[1]).map(([t, sh]) => (
          <div key={t} className="soldline">
            <img src={logo(t)} alt="" /><span>{teams[t].name}</span>
            <b>{sh.toFixed(2)}%</b><em className="dim">{fmt$((sh / 100) * potForSettlement)}</em>
          </div>
        ))}
        {!Object.keys(earnedByTeam).length && <p className="dim">🦗 No games final yet — season starts Sept 10. The tracker wakes itself up.</p>}
      </div>
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
      <h2>Trade desk</h2>
      {!soldTeams.length ? <p className="dim">Trades open once teams are sold.</p> : (
        <div className="tradeform">
          <select value={form.team} onChange={e => setForm({ ...form, team: e.target.value, from: "" })}>
            <option value="">team…</option>
            {soldTeams.map(t => <option key={t} value={t}>{teams[t].name}</option>)}
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
  const [orderText, setOrderText] = useState(state.auction.order.join(" "));
  useEffect(() => setGroups(state.config.groups), [state.config.groups]);
  useEffect(() => setOrderText(state.auction.order.join(" ")), [state.auction.order]);

  return (
    <div className="pad setup">
      <h2>Groups</h2>
      <p className="dim">Aliases = names the listener should recognize as that group ("joon, gunther, dave"). Comma-separated.</p>
      {groups.map((g, i) => (
        <div key={g.id} className="grouprow">
          <div className="row gap">
            <input value={g.name} placeholder="group name" onChange={e => setGroups(groups.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input type="number" step="500" value={g.budget} style={{ width: 90 }}
              onChange={e => setGroups(groups.map((x, j) => j === i ? { ...x, budget: Number(e.target.value) } : x))} />
            <button onClick={() => setGroups(groups.filter((_, j) => j !== i))}>✕</button>
          </div>
          <input value={g.aliases || ""} placeholder="aliases (member names)"
            onChange={e => setGroups(groups.map((x, j) => j === i ? { ...x, aliases: e.target.value } : x))} />
        </div>
      ))}
      <div className="row gap">
        <button onClick={() => setGroups([...groups, { id: `g${Date.now()}`, name: `Group ${groups.length + 1}`, budget: 7000, aliases: "" }])}>+ group</button>
        <button className="go" onClick={() => act("setGroups", { groups })}>Save groups</button>
      </div>

      <h2>Our group</h2>
      <select value={state.config.ourGroupId} onChange={e => act("setOurGroup", { groupId: e.target.value })}>
        {state.config.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>

      <h2>Pot & discipline</h2>
      <label>Prior pot guess $
        <input type="number" step="1000" defaultValue={state.config.priorPot} onBlur={e => act("setPriorPot", { pot: e.target.value })} />
      </label>
      <label>Target margin (bid up to fair × this)
        <input type="number" step="0.05" min="0.3" max="1.5" defaultValue={state.config.targetMargin} onBlur={e => act("setTargetMargin", { margin: e.target.value })} />
      </label>

      <h2>Auction order</h2>
      <p className="dim">Space-separated abbreviations, in the commissioners' drawn order — or shuffle. Missing teams get appended automatically.</p>
      <textarea rows="3" value={orderText} onChange={e => setOrderText(e.target.value)} />
      <div className="row gap">
        <button onClick={() => act("setOrder", { order: orderText.trim().toUpperCase().split(/[\s,]+/).filter(Boolean) })}>Save order</button>
        <button onClick={() => act("shuffleOrder")}>Shuffle</button>
      </div>

      <h2>Danger zone</h2>
      <button className="warn" onClick={() => { if (confirm("Reset the entire auction and all trades?")) act("resetAuction"); }}>
        Reset auction + trades
      </button>
    </div>
  );
}
