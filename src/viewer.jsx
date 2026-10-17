// The league-facing site: what every group sees week to week.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, membersOf } from "./avatars.jsx";
import {
  fmt$, fmtSigned$, fmtPct, pctRound, logo, moji, shortName, memberNames, groupName,
  colorOf, gameStatus, recStr, dayLabel
} from "./util.jsx";

const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th");
const fmtWL = r => `${+r.w.toFixed(1)}–${+r.l.toFixed(1)}`;
const TYPE_LABEL = {
  regWin: "Regular-season wins", berth: "Made the playoffs", reachDiv: "Wild Card win / bye", wcWin: "Wild Card win",
  divWin: "Divisional-round win", confWin: "Conference title", sbWin: "Super Bowl win", divTitle: "Division title", oneSeed: "#1 seed"
};

// ---------------- derived data shared by every screen ----------------
export function useDerived(view) { return useMemo(() => derive(view), [view]); }

function derive(view) {
  const { state, season, projections, summaries = {}, earnedByTeam = {}, valuation, payoutProfile: P = {}, nflStandings, events = [] } = view;
  const pot = view.potForSettlement || 0;
  const config = state.config;
  const groups = config.groups;
  const weeks = season?.weeks || [];
  const owners = projections?.currentOwners || {};
  const $ = w => ((w || 0) / 100) * pot;
  const color = gid => colorOf(config, gid);
  const name = gid => memberNames(groupName(config, gid));
  const short = gid => shortName(groupName(config, gid));
  const vt = t => valuation?.teams?.[t] || {};
  const teamsOf = gid => Object.keys(owners).filter(t => (owners[t]?.[gid] || 0) > 0).sort((a, b) => (vt(b).share || 0) - (vt(a).share || 0));
  const tradeCashFor = (t, gid) => state.trades.reduce((s, tr) => tr.team !== t ? s : s + (tr.from === gid ? tr.cash : 0) - (tr.to === gid ? tr.cash : 0), 0);
  const paidFor = (t, gid) => (state.auction.sales[t]?.group === gid ? state.auction.sales[t].amount : 0) - tradeCashFor(t, gid);
  const record = t => season?.teamRecord?.[t] || { w: 0, l: 0, t: 0 };
  const banked$ = t => $(earnedByTeam[t]);
  const projected$ = t => $(vt(t).share);
  const isDone = w => w.games.length > 0 && w.games.every(g => g.final || g.state === "post");
  const doneWeeks = weeks.filter(isDone);
  const weekEarn = (gid, key) => season?.byGroupWeek?.[gid]?.[key] || 0;
  const credit$ = g => $(g.seasontype === 2 ? P.regWin : ({ 1: (P.wcWin || 0) + (P.reachDiv || 0), 2: P.divWin, 3: P.confWin, 5: P.sbWin })[g.week] || 0);

  // cumulative banked after each completed week (index 0 = before Week 1)
  const cum = Object.fromEntries(groups.map(g => {
    let run = 0; const arr = [0];
    for (const w of doneWeeks) { run += weekEarn(g.id, w.key); arr.push(run); }
    return [g.id, arr];
  }));
  const rankBy = val => Object.fromEntries([...groups].sort((a, b) => val(b.id) - val(a.id)).map((g, i) => [g.id, i + 1]));
  const n = doneWeeks.length;
  const rankAt = i => rankBy(gid => cum[gid][Math.max(0, Math.min(i, n))]);
  const bankedNow = gid => summaries[gid]?.earnedDollars || 0;
  const rankLive = rankBy(bankedNow);
  const curWeek = weeks.find(w => w.key === season?.currentWeek);
  const curHasFinals = !!curWeek && !isDone(curWeek) && curWeek.games.some(g => g.final);
  const moveBase = curHasFinals ? rankAt(n) : n > 0 ? rankAt(n - 1) : rankLive;
  const move = gid => (moveBase[gid] || 0) - (rankLive[gid] || 0); // + = climbed

  const groupRecord = gid => {
    let w = 0, l = 0, t = 0;
    for (const tm of teamsOf(gid)) { const p = (owners[tm]?.[gid] || 0) / 100, r = record(tm); w += r.w * p; l += r.l * p; t += r.t * p; }
    return { w, l, t };
  };
  const stats = gid => {
    const s = summaries[gid] || { spent: 0, tradeCash: 0, earnedDollars: 0 };
    const pj = projections?.groups?.[gid] || {};
    const netCost = s.spent - s.tradeCash;
    return {
      banked: s.earnedDollars, netCost, todayNet: s.earnedDollars - netCost,
      projected: pj.projectedEarned || 0, projNet: pj.projectedNet || 0,
      record: groupRecord(gid), teams: teamsOf(gid), rank: rankLive[gid], move: move(gid)
    };
  };

  function weekTable(week) {
    const rows = Object.fromEntries(groups.map(g => [g.id, { gid: g.id, earned: weekEarn(g.id, week.key), w: 0, l: 0, games: 0, possible: 0, expected: 0 }]));
    for (const g of week.games) {
      const sides = [[g.home, g.homeOwners, g.pHome], [g.away, g.awayOwners, g.pHome == null ? null : 1 - g.pHome]];
      for (const [team, own, p] of sides) for (const [gid, pc] of Object.entries(own || {})) {
        const r = rows[gid]; if (!r || !(pc > 0)) continue; const f = pc / 100;
        r.games += f;
        if (g.final && g.winner) { if (g.winner === team) r.w += f; else r.l += f; }
        else if (!g.final && g.state !== "post") { const c = credit$(g) * f; r.possible += c; r.expected += c * (p ?? 0.5); }
      }
    }
    return Object.values(rows);
  }

  function recap(week) {
    const done = week.games.filter(g => g.final && g.winner);
    if (!done.length) return [];
    const tbl = weekTable(week).filter(r => r.w + r.l > 0);
    const out = [];
    const top = [...tbl].sort((a, b) => b.earned - a.earned)[0];
    if (top && top.earned > 0) out.push({ icon: "🏆", gid: top.gid, text: `${name(top.gid)} led ${week.label} with ${fmt$(top.earned)} (${fmtWL(top)})` });
    for (const r of tbl) if (r.l === 0 && r.w >= 2) out.push({ icon: "🧹", gid: r.gid, text: `${name(r.gid)} swept: ${fmtWL(r)}` });
    for (const r of tbl) if (r.w === 0 && r.l >= 1) out.push({ icon: "🥶", gid: r.gid, text: `${name(r.gid)} went ${fmtWL(r)}` });
    const pairs = {};
    for (const g of done) {
      const ho = Object.keys(g.homeOwners || {}).filter(k => g.homeOwners[k] > 0), ao = Object.keys(g.awayOwners || {}).filter(k => g.awayOwners[k] > 0);
      if (ho.length !== 1 || ao.length !== 1) continue;
      if (ho[0] === ao[0]) { out.push({ icon: "💰", gid: ho[0], text: `${name(ho[0])} owned both sides of ${g.away} @ ${g.home} and got paid either way` }); continue; }
      const k = [ho[0], ao[0]].sort().join("|"), w = g.winner === g.home ? ho[0] : ao[0];
      (pairs[k] ??= { n: 0, wins: {} }).n++; pairs[k].wins[w] = (pairs[k].wins[w] || 0) + 1;
    }
    const best = Object.entries(pairs).sort((a, b) => b[1].n - a[1].n)[0];
    if (best && best[1].n >= 2) {
      const [a, b] = best[0].split("|"); const wa = best[1].wins[a] || 0, wb = best[1].wins[b] || 0;
      out.push({ icon: "⚔️", text: `${short(a)} vs ${short(b)}: ${best[1].n} head-to-heads, ${wa === wb ? `split ${wa}–${wb}` : `${wa > wb ? short(a) : short(b)} took ${Math.max(wa, wb)}–${Math.min(wa, wb)}`}` });
    }
    const i = doneWeeks.findIndex(w => w.key === week.key);
    if (i >= 1) {
      const before = rankAt(i), after = rankAt(i + 1);
      const climb = groups.map(g => ({ gid: g.id, d: before[g.id] - after[g.id] })).sort((a, b) => b.d - a.d)[0];
      if (climb && climb.d > 0) out.push({ icon: "📈", gid: climb.gid, text: `${name(climb.gid)} climbed from ${ordinal(before[climb.gid])} to ${ordinal(after[climb.gid])}` });
    }
    return out;
  }

  const seedOf = t => nflStandings?.teams?.[t]?.seed || null;
  const eventsFor = t => events.filter(e => e.team === t);
  const gamesOf = t => weeks.flatMap(w => w.games.filter(g => g.home === t || g.away === t).map(g => ({ ...g, weekLabel: w.label, weekKey: w.key })));

  return {
    view, P, pot, config, groups, weeks, owners, $, color, name, short, vt, teamsOf, paidFor, record, banked$, projected$,
    doneWeeks, weekEarn, cum, stats, weekTable, recap, credit$, seedOf, eventsFor, gamesOf, isDone, rankLive
  };
}

// ---------------- small building blocks ----------------
export function GroupDot({ d, gid, size = 9 }) {
  return <span className="gdot" style={{ background: d.color(gid), width: size, height: size }} aria-hidden="true" />;
}
export function OwnerChips({ d, own, me, go, compact = false }) {
  const entries = Object.entries(own || {}).filter(([, p]) => p > 0);
  if (!entries.length) return <span className="ochip none">unowned</span>;
  return <span className="ochips">{entries.map(([gid, p]) => (
    <button key={gid} className={"ochip" + (gid === me ? " me" : "")} onClick={e => { e.stopPropagation(); go?.({ group: gid, team: null }); }} title={d.name(gid)}>
      <GroupDot d={d} gid={gid} />{compact ? d.short(gid) : d.short(gid)}{p < 100 ? ` ${fmtPct(p)}` : ""}
    </button>
  ))}</span>;
}
function Tile({ label, value, sub, tone }) {
  return <div className="tile"><label>{label}</label><b className={tone || ""}>{value}</b>{sub && <span className="dim">{sub}</span>}</div>;
}
function Move({ v }) {
  if (!v) return <span className="mv flat" aria-label="no change">–</span>;
  return v > 0 ? <span className="mv up" aria-label={`up ${v}`}>▲{v}</span> : <span className="mv down" aria-label={`down ${-v}`}>▼{-v}</span>;
}
function Crew({ d, gid, me, size = 20 }) {
  return <span className="crewav">{membersOf(groupName(d.config, gid)).map(n => (
    <Avatar key={n} name={n} title={n} size={size} mode={!me || gid === me ? "hero" : "weak"} />
  ))}</span>;
}

// ---------------- game card (scoreboard style) ----------------
function GameCard({ d, g, me, go }) {
  const mine = me && (g.homeOwners?.[me] > 0 || g.awayOwners?.[me] > 0);
  const live = g.state === "in";
  const pending = !g.final && g.state !== "post";
  const rows = [
    { team: g.away, score: g.awayScore, own: g.awayOwners, p: g.pHome == null ? null : 1 - g.pHome },
    { team: g.home, score: g.homeScore, own: g.homeOwners, p: g.pHome }
  ];
  const rec = t => recStr(d.record(t));
  return (
    <div className={"gcard" + (mine ? " mine" : "") + (live ? " live" : "")} style={mine ? { "--mine": d.color(me) } : undefined}>
      <div className="gstatus"><span className={live ? "livepill" : "dim"}>{gameStatus(g)}</span>{g.neutral && <span className="dim"> · neutral site</span>}</div>
      {rows.map(r => {
        const won = g.final && g.winner === r.team, lost = g.final && g.winner && g.winner !== r.team;
        return (
          <div key={r.team} className={"grow" + (won ? " won" : "") + (lost ? " lost" : "")}>
            <button className="gteam" onClick={() => go({ team: r.team, group: null })}>
              <img src={logo(r.team)} alt="" /><b>{r.team}</b><span className="dim">{rec(r.team)}</span>
            </button>
            <OwnerChips d={d} own={r.own} me={me} go={go} />
            <span className="gscore">{g.final || live ? (r.score ?? "") : r.p != null ? pctRound(r.p) : ""}</span>
          </div>
        );
      })}
      {pending && g.pHome != null && (
        <div className="probbar" aria-label={`${g.away} ${pctRound(1 - g.pHome)}, ${g.home} ${pctRound(g.pHome)}`}>
          <span style={{ width: `${(1 - g.pHome) * 100}%`, background: ownerColor(d, g.awayOwners) }} />
          <span style={{ width: `${g.pHome * 100}%`, background: ownerColor(d, g.homeOwners) }} />
        </div>
      )}
      {pending && <div className="gfoot dim">{fmt$(d.credit$(g))} on the line</div>}
      {(g.credits || []).filter(c => c.credit > 0).map(c => (
        <div key={c.team} className="gfoot credit">+{fmt$(d.$(c.credit))} to <OwnerChips d={d} own={c.owners} me={me} go={go} /> <span className="dim">({c.team})</span></div>
      ))}
    </div>
  );
}
const ownerColor = (d, own) => { const top = Object.entries(own || {}).sort((a, b) => b[1] - a[1])[0]; return top ? d.color(top[0]) : "#4a403e"; };

// ---------------- WEEK ----------------
export function Week({ view, me, route, go }) {
  const d = useDerived(view);
  const [onlyMine, setOnlyMine] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const navRef = useRef(null);
  const weeks = d.weeks;
  const key = route.arg && weeks.some(w => w.key === route.arg) ? route.arg : view.season?.currentWeek;
  const idx = weeks.findIndex(w => w.key === key);
  const week = weeks[idx];
  useEffect(() => { // center the selected week chip without scrolling the page
    const nav = navRef.current, el = nav?.querySelector(".on");
    if (nav && el) nav.scrollLeft = el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2;
  }, [key]);
  if (!week) return <div className="pad"><p className="dim">The schedule is loading…</p></div>;

  const table = d.weekTable(week).sort((a, b) => b.earned - a.earned || b.expected - a.expected);
  const maxBar = Math.max(1, ...table.map(r => r.earned + r.possible));
  const recap = d.recap(week);
  const games = week.games.filter(g => !onlyMine || g.homeOwners?.[me] > 0 || g.awayOwners?.[me] > 0);
  const byDay = [];
  for (const g of games) { const k = dayLabel(g.date); const last = byDay[byDay.length - 1]; if (last?.day === k) last.games.push(g); else byDay.push({ day: k, games: [g] }); }
  const first = week.games[0]?.date, last = week.games[week.games.length - 1]?.date;
  const range = first ? `${new Date(first).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(last).toLocaleDateString([], { month: "short", day: "numeric" })}` : "";
  const isCurrent = week.key === view.season?.currentWeek;
  const meRow = me && table.find(r => r.gid === me);

  return (
    <div className="pad">
      <div className="weekhead">
        <button className="arrow" disabled={idx <= 0} onClick={() => go({ arg: weeks[idx - 1].key })} aria-label="Previous week">◀</button>
        <div className="wtitle"><h1>{week.label}</h1><span className="dim">{range}{isCurrent ? " · this week" : ""}</span></div>
        <button className="arrow" disabled={idx >= weeks.length - 1} onClick={() => go({ arg: weeks[idx + 1].key })} aria-label="Next week">▶</button>
      </div>
      <div className="weeknav" ref={navRef}>
        {weeks.map(w => (
          <button key={w.key} className={(w.key === key ? "on" : "") + (w.key === view.season?.currentWeek ? " now" : "")} onClick={() => go({ arg: w.key })}>
            {w.seasontype === 2 ? `Wk ${w.week}` : w.label}
          </button>
        ))}
      </div>

      {meRow && (meRow.games > 0) && (
        <div className="mecard" style={{ "--mine": d.color(me) }}>
          <Crew d={d} gid={me} me={me} size={26} />
          <div>
            <b>Your {week.label}</b>
            <div className="dim">
              {meRow.w + meRow.l > 0 ? `${fmtWL(meRow)} so far · ${fmt$(meRow.earned)} banked` : `${+meRow.games.toFixed(1)} games`}
              {meRow.possible > 0 ? ` · ${fmt$(meRow.possible)} still on the line (≈${fmt$(meRow.expected)} expected)` : ""}
            </div>
          </div>
        </div>
      )}

      <h2>💵 {week.label} money</h2>
      <div className="wboard">
        {table.map((r, i) => (
          <button key={r.gid} className={"wrow" + (r.gid === me ? " me" : "")} onClick={() => go({ group: r.gid, team: null })}>
            <span className="wrank">{i + 1}</span>
            <span className="wname"><GroupDot d={d} gid={r.gid} /> {d.name(r.gid)}</span>
            <span className="wbar" aria-hidden="true">
              <span style={{ width: `${(r.earned / maxBar) * 100}%`, background: d.color(r.gid) }} />
              {r.possible > 0 && <span className="ghost" style={{ width: `${(r.possible / maxBar) * 100}%`, borderColor: d.color(r.gid) }} />}
            </span>
            <span className="wnum"><b>{fmt$(r.earned)}</b><span className="dim">{r.w + r.l > 0 ? ` ${fmtWL(r)}` : ""}{r.possible > 0 ? ` · +${fmt$(r.possible)} live` : ""}</span></span>
          </button>
        ))}
      </div>
      <p className="dim small">Solid = banked this week. Outline = still on the line in unfinished games.</p>

      {recap.length > 0 && (
        <div className="recap">
          <h3>Week recap</h3>
          {recap.map((x, i) => <div key={i} className="recapline"><span>{x.icon}</span><span>{x.text}</span></div>)}
        </div>
      )}

      <div className="gameshead">
        <h2>🏟️ Games</h2>
        <div className="row" style={{ gap: ".4rem" }}>
          {me && <button className={"seg" + (onlyMine ? " on" : "")} onClick={() => setOnlyMine(v => !v)}>{onlyMine ? "Showing my games" : "Only my games"}</button>}
          <button className="seg" disabled={syncing} onClick={async () => { setSyncing(true); await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {}); setSyncing(false); }}>{syncing ? "Refreshing…" : "↻ Scores"}</button>
        </div>
      </div>
      {byDay.map(day => (
        <div key={day.day}>
          <h3>{day.day}</h3>
          <div className="gcards">{day.games.map(g => <GameCard key={g.id} d={d} g={g} me={me} go={go} />)}</div>
        </div>
      ))}
      {!games.length && <p className="dim">None of your teams play this week.</p>}
      <p className="dim small" style={{ marginTop: "1rem" }}>Scores update from ESPN every hour (last pull {view.scheduleFetchedAt ? new Date(view.scheduleFetchedAt).toLocaleString() : "—"}). Win chances come from the season simulation.</p>
    </div>
  );
}

// ---------------- STANDINGS ----------------
export function Standings({ view, me, go }) {
  const d = useDerived(view);
  const [sort, setSort] = useState("banked");
  const curKey = view.season?.currentWeek;
  const rows = d.groups.map(g => ({ gid: g.id, ...d.stats(g.id), wk: d.weekEarn(g.id, curKey) }));
  rows.sort((a, b) => sort === "banked" ? b.banked - a.banked : sort === "today" ? b.todayNet - a.todayNet : b.projNet - a.projNet);
  const teamRows = Object.keys(view.state.auction.sales).map(t => {
    const sale = view.state.auction.sales[t];
    return { t, gid: sale.group, paid: sale.amount, projected: d.projected$(t), banked: d.banked$(t) };
  });
  const byProfit = [...teamRows].sort((a, b) => (b.projected - b.paid) - (a.projected - a.paid));
  const curLabel = d.weeks.find(w => w.key === curKey)?.label || "This week";

  return (
    <div className="pad">
      <h1 className="pagetitle">Standings</h1>
      <div className="segrow" role="tablist">
        {[["banked", "Money banked"], ["today", "If it ended today"], ["proj", "Projected finish"]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={sort === k} className={"seg" + (sort === k ? " on" : "")} onClick={() => setSort(k)}>{l}</button>
        ))}
      </div>
      <div className="stlist">
        {rows.map((r, i) => {
          const primary = sort === "banked" ? fmt$(r.banked) : sort === "today" ? fmtSigned$(r.todayNet) : fmtSigned$(r.projNet);
          const tone = sort === "banked" ? "" : (sort === "today" ? r.todayNet : r.projNet) >= 0 ? "green" : "red";
          const others = [
            sort !== "banked" && `banked ${fmt$(r.banked)}`,
            sort !== "today" && `net today ${fmtSigned$(r.todayNet)}`,
            sort !== "proj" && `proj. net ${fmtSigned$(r.projNet)}`
          ].filter(Boolean).join(" · ");
          return (
            <button key={r.gid} className={"strow" + (r.gid === me ? " me" : "")} onClick={() => go({ group: r.gid, team: null })}>
              <span className="strk"><b>{i + 1}</b>{sort === "banked" && <Move v={r.move} />}</span>
              <span className="stmain">
                <span className="gname"><GroupDot d={d} gid={r.gid} /> {d.name(r.gid)}</span>
                <span className="dim small">{r.teams.length} team{r.teams.length === 1 ? "" : "s"} · {+r.record.w.toFixed(1)}–{+r.record.l.toFixed(1)}{r.record.t ? `–${+r.record.t.toFixed(1)}` : ""}{r.wk ? ` · ${fmt$(r.wk)} ${curLabel.toLowerCase().startsWith("week") ? "this week" : curLabel}` : ""}</span>
              </span>
              <span className="stnums"><b className={tone}>{primary}</b><span className="dim small">{others}</span></span>
            </button>
          );
        })}
      </div>
      <p className="dim small">
        <b>Banked</b>: money your teams have earned so far. <b>Net today</b>: banked minus what you paid (what you'd collect or owe if the season stopped now).
        <b> Proj. net</b>: banked + the simulation's expected rest of season, minus what you paid. Tap a group for its page.
      </p>

      <h2>📈 Money banked, week by week</h2>
      <EarningsChart d={d} me={me} go={go} />

      <h2>🎯 Best and worst buys</h2>
      <p className="dim small">Projected season earnings minus auction price, across the league.</p>
      <div className="buys">
        <div><h3>Bargains</h3>{byProfit.slice(0, 5).map(r => <BuyRow key={r.t} d={d} r={r} me={me} go={go} />)}</div>
        <div><h3>Overpays</h3>{byProfit.slice(-5).reverse().map(r => <BuyRow key={r.t} d={d} r={r} me={me} go={go} />)}</div>
      </div>

      <h2>🤝 Trade log</h2>
      {!view.state.trades.length ? <p className="dim">No trades recorded yet. Trades count once Jamie & Dylan confirm them.</p> : (
        <div className="tlist">{view.state.trades.map(tr => (
          <div key={tr.id} className="tline2">
            <img className="tinylogo" src={logo(tr.team)} alt="" />
            <span>{tr.pct}% of {tr.team}: <GroupDot d={d} gid={tr.from} /> {d.short(tr.from)} → <GroupDot d={d} gid={tr.to} /> {d.short(tr.to)}</span>
            <b>{fmt$(tr.cash)}</b><span className="dim small">{new Date(tr.ts).toLocaleDateString()}</span>
          </div>
        ))}</div>
      )}
    </div>
  );
}
function BuyRow({ d, r, me, go }) {
  const diff = r.projected - r.paid;
  return (
    <button className="buyrow" onClick={() => go({ team: r.t, group: null })}>
      <img src={logo(r.t)} alt="" /><span>{moji(r.t)} {r.t}</span>
      <span className={"ochip" + (r.gid === me ? " me" : "")}><GroupDot d={d} gid={r.gid} />{d.short(r.gid)}</span>
      <span className="dim small">paid {fmt$(r.paid)}</span>
      <b className={diff >= 0 ? "green" : "red"}>{fmtSigned$(diff)}</b>
    </button>
  );
}

// Cumulative banked money per group after each completed week.
function EarningsChart({ d, me, go }) {
  const [hover, setHover] = useState(null);
  const [W, setW] = useState(640);
  const svgRef = useRef(null), wrapRef = useRef(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const n = d.doneWeeks.length;
  if (n < 1) return <p className="dim">The chart fills in once Week 1 is final.</p>;
  const H = W < 480 ? 210 : 250, L = 46, R = 12, T = 12, B = 24;
  const max = Math.max(1, ...d.groups.map(g => d.cum[g.id][n]));
  const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000].find(s => max / s <= 4) || 10000;
  const top = Math.ceil(max / step) * step;
  const x = i => L + (i / n) * (W - L - R);
  const y = v => T + (1 - v / top) * (H - T - B);
  const order = [...d.groups].sort((a, b) => d.cum[b.id][n] - d.cum[a.id][n]);
  const onMove = e => {
    const r = svgRef.current.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n, Math.round(((vx - L) / (W - L - R)) * n))));
  };
  const label = i => (i === 0 ? "Start" : d.doneWeeks[i - 1].label);
  const hi = hover ?? null;
  return (
    <div className="chart">
      <div className="legend">{order.map(g => (
        <button key={g.id} className={"lg" + (g.id === me ? " me" : "")} onClick={() => go({ group: g.id, team: null })}>
          <svg width="16" height="6" aria-hidden="true"><line x1="0" y1="3" x2="16" y2="3" stroke={d.color(g.id)} strokeWidth="2.5" strokeLinecap="round" /></svg>
          {d.short(g.id)} <b>{fmt$(d.cum[g.id][n])}</b>
        </button>
      ))}</div>
      <div className="chartwrap" ref={wrapRef}>
        <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative money banked by each group after each week"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onMove}>
          {Array.from({ length: top / step + 1 }, (_, k) => k * step).map(v => (
            <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 6} y={y(v) + 4} className="axis" textAnchor="end">{fmt$(v)}</text></g>
          ))}
          {Array.from({ length: n + 1 }, (_, i) => i).filter(i => n <= (W < 480 ? 6 : 10) || i % 2 === 0 || i === n).map(i => (
            <text key={i} x={x(i)} y={H - 7} className="axis" textAnchor="middle">{i === 0 ? "" : d.doneWeeks[i - 1].seasontype === 2 ? `Wk ${d.doneWeeks[i - 1].week}` : d.doneWeeks[i - 1].label}</text>
          ))}
          {hi != null && <line x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} className="cross" />}
          {[...order].reverse().map(g => {
            const pts = d.cum[g.id].map((v, i) => `${x(i)},${y(v)}`).join(" ");
            const isMe = g.id === me;
            return (
              <g key={g.id} opacity={me && !isMe ? 0.6 : 1}>
                <polyline points={pts} fill="none" stroke={d.color(g.id)} strokeWidth={isMe ? 3 : 2} strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={x(n)} cy={y(d.cum[g.id][n])} r="4.5" fill={d.color(g.id)} className="ring" />
                {hi != null && <circle cx={x(hi)} cy={y(d.cum[g.id][hi])} r="4" fill={d.color(g.id)} className="ring" />}
              </g>
            );
          })}
        </svg>
        {hi != null && (
          <div className="ctip" style={{ left: `${(x(hi) / W) * 100}%`, transform: x(hi) > W / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
            <div className="dim small">{label(hi)}</div>
            {[...d.groups].sort((a, b) => d.cum[b.id][hi] - d.cum[a.id][hi]).map(g => (
              <div key={g.id} className="ctrow">
                <svg width="12" height="4" aria-hidden="true"><line x1="0" y1="2" x2="12" y2="2" stroke={d.color(g.id)} strokeWidth="2.5" /></svg>
                <b>{fmt$(d.cum[g.id][hi])}</b><span className="dim">{d.short(g.id)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- TEAMS ----------------
export function Teams({ view, me, go }) {
  const d = useDerived(view);
  const [sort, setSort] = useState("owner");
  const [filter, setFilter] = useState("all");
  const all = Object.keys(view.teams).map(t => {
    const sale = view.state.auction.sales[t];
    const own = d.owners[t] || (sale ? { [sale.group]: 100 } : {});
    const v = d.vt(t);
    return { t, own, paid: sale?.amount || 0, banked: d.banked$(t), projected: d.projected$(t), rec: d.record(t), pPl: v.pPlayoffs ?? null, seed: d.seedOf(t), owner: sale?.group };
  }).filter(r => filter === "all" || r.own[filter] > 0);
  const sorters = {
    owner: (a, b) => d.groups.findIndex(g => g.id === a.owner) - d.groups.findIndex(g => g.id === b.owner) || b.projected - a.projected,
    value: (a, b) => b.projected - a.projected,
    record: (a, b) => (b.rec.w - b.rec.l) - (a.rec.w - a.rec.l) || b.rec.w - a.rec.w,
    profit: (a, b) => (b.projected - b.paid) - (a.projected - a.paid),
    playoffs: (a, b) => (b.pPl ?? 0) - (a.pPl ?? 0)
  };
  all.sort(sorters[sort]);
  let lastOwner = null;
  return (
    <div className="pad">
      <h1 className="pagetitle">All 32 teams</h1>
      <div className="segrow">
        <label className="dim small" htmlFor="tsort">Sort</label>
        <select id="tsort" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="owner">By group</option><option value="value">Projected earnings</option><option value="record">Record</option>
          <option value="profit">Profit vs price</option><option value="playoffs">Playoff chances</option>
        </select>
      </div>
      <div className="segrow chips">
        <button className={"seg" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>Everyone</button>
        {d.groups.map(g => (
          <button key={g.id} className={"seg" + (filter === g.id ? " on" : "")} onClick={() => setFilter(g.id)}><GroupDot d={d} gid={g.id} /> {d.short(g.id)}{g.id === me ? " (you)" : ""}</button>
        ))}
      </div>
      <div className="tlist">
        {all.map(r => {
          const header = sort === "owner" && r.owner !== lastOwner ? (lastOwner = r.owner) : null;
          return (
            <React.Fragment key={r.t}>
              {header && <div className="ownerhead"><GroupDot d={d} gid={header} size={11} /> <b>{d.name(header)}</b>
                <button className="tiny" onClick={() => go({ group: header, team: null })}>group page →</button></div>}
              <button className={"teamrow" + (r.own[me] > 0 ? " mine" : "")} style={r.own[me] > 0 ? { "--mine": d.color(me) } : undefined} onClick={() => go({ team: r.t, group: null })}>
                <img src={logo(r.t)} alt="" />
                <span className="tmain">
                  <b>{moji(r.t)} {view.teams[r.t].name}</b>
                  <span className="dim small">{recStr(r.rec)}{r.seed ? (r.seed <= 7 ? ` · ${view.teams[r.t].conf} #${r.seed} seed` : ` · ${ordinal(r.seed)} in ${view.teams[r.t].conf}`) : ""}{r.pPl != null ? ` · ${pctRound(r.pPl)} playoffs` : ""}</span>
                </span>
                <span className="tnums">
                  <OwnerChips d={d} own={r.own} me={me} go={go} />
                  <span className="dim small">paid {fmt$(r.paid)} · banked {fmt$(r.banked)}</span>
                  <span className="small">proj. {fmt$(r.projected)} <b className={r.projected - r.paid >= 0 ? "green" : "red"}>({fmtSigned$(r.projected - r.paid)})</b></span>
                </span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- sheets (team page / group page) ----------------
function Sheet({ label, onClose, children }) {
  useEffect(() => {
    const f = e => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { removeEventListener("keydown", f); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={e => e.stopPropagation()}>
        <div className="sheettop"><ShareButton /><button className="sheetx" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}
function ShareButton() {
  const [done, setDone] = useState(false);
  return <button className="tiny" onClick={async () => {
    const url = location.href;
    try { if (navigator.share) await navigator.share({ url }); else { await navigator.clipboard.writeText(url); setDone(true); setTimeout(() => setDone(false), 1800); } } catch {}
  }}>{done ? "Link copied" : "Share link"}</button>;
}

export function TeamSheet({ view, team, me, go }) {
  const d = useDerived(view);
  const t = team, info = view.teams[t];
  if (!info) return null;
  const close = () => go({ team: null });
  const v = d.vt(t), st = view.nflStandings?.teams?.[t];
  const sale = view.state.auction.sales[t];
  const own = d.owners[t] || {};
  const banked = d.banked$(t), projected = d.projected$(t);
  const evs = d.eventsFor(t);
  const breakdown = Object.entries(evs.reduce((m, e) => { (m[e.type] ??= { n: 0, c: 0 }); m[e.type].n++; m[e.type].c += e.credit; return m; }, {}));
  const games = d.gamesOf(t);
  const trades = view.state.trades.filter(tr => tr.team === t);
  const seedTxt = st?.seed ? (st.seed <= 7 ? `${info.conf} #${st.seed} seed if the season ended today` : `${ordinal(st.seed)} in the ${info.conf}, outside the playoff line`) : null;
  return (
    <Sheet label={info.name} onClose={close}>
      <div className="shead">
        <img src={logo(t)} alt="" className="biglogo" />
        <div>
          <h2>{moji(t)} {info.name}</h2>
          <div className="dim">{info.conf} {info.div} · {recStr(d.record(t))}{st?.streak && st.streak !== "-" ? ` · ${st.streak}` : ""}{st?.diff != null ? ` · ${st.diff > 0 ? "+" : ""}${st.diff} pt diff` : ""}</div>
          {seedTxt && <div className="small">{seedTxt}</div>}
        </div>
      </div>
      <div className="ownerline">
        <OwnerChips d={d} own={own} me={me} go={go} />
        {sale && <span className="dim small">bought by {d.short(sale.group)} for {fmt$(sale.amount)}</span>}
      </div>
      <div className="tiles">
        <Tile label="Banked" value={fmt$(banked)} sub={`${(evs.filter(e => e.type === "regWin").length)} wins paid`} />
        <Tile label="Projected season" value={fmt$(projected)} sub={`≈ ${(v.expWins ?? 0).toFixed(1)} wins`} />
        {sale && <Tile label="vs price paid" value={fmtSigned$(projected - sale.amount)} tone={projected - sale.amount >= 0 ? "green" : "red"} />}
        <Tile label="Still to earn" value={fmt$(Math.max(0, projected - banked))} />
      </div>
      <div className="tiles">
        <Tile label="Make playoffs" value={pctRound(v.pPlayoffs ?? 0)} />
        <Tile label="Win division" value={pctRound(v.pDivTitle ?? 0)} />
        <Tile label="Win conference" value={fmtPct((v.pConfWin ?? 0) * 100)} />
        <Tile label="Win Super Bowl" value={fmtPct((v.pSbWin ?? 0) * 100)} />
      </div>
      {breakdown.length > 0 && (
        <>
          <h3>Earnings so far</h3>
          {breakdown.map(([type, x]) => (
            <div key={type} className="kv"><span>{TYPE_LABEL[type] || type}{x.n > 1 ? ` × ${x.n}` : ""}</span><b>{fmt$(d.$(x.c))}</b></div>
          ))}
        </>
      )}
      {trades.length > 0 && (
        <>
          <h3>Trades</h3>
          {trades.map(tr => <div key={tr.id} className="kv"><span>{tr.pct}%: {d.short(tr.from)} → {d.short(tr.to)}</span><b>{fmt$(tr.cash)}</b></div>)}
        </>
      )}
      <h3>Schedule</h3>
      <div className="sched">
        {games.map(g => {
          const home = g.home === t, opp = home ? g.away : g.home;
          const oppOwn = home ? g.awayOwners : g.homeOwners;
          const won = g.final && g.winner === t, lost = g.final && g.winner && g.winner !== t;
          const p = g.pHome == null ? null : home ? g.pHome : 1 - g.pHome;
          const earned = (g.credits || []).filter(c => c.team === t).reduce((s, c) => s + c.credit, 0);
          return (
            <div key={g.id} className={"srow" + (won ? " won" : "") + (lost ? " lost" : "")}>
              <span className="dim small swk">{g.seasontype === 2 ? `Wk ${g.week}` : g.weekLabel}</span>
              <button className="sopp" onClick={() => go({ team: opp })}>{home ? "vs" : "@"} <img src={logo(opp)} alt="" /> {opp}</button>
              <OwnerChips d={d} own={oppOwn} me={me} go={go} />
              <span className="sres">
                {g.final ? <><b>{won ? "W" : lost ? "L" : "T"}</b> {home ? `${g.homeScore}–${g.awayScore}` : `${g.awayScore}–${g.homeScore}`}</> :
                  g.state === "in" ? <span className="livepill">{gameStatus(g)}</span> :
                    <span className="dim">{p != null ? `${pctRound(p)} · ` : ""}{gameStatus(g)}</span>}
              </span>
              <span className="searn">{earned > 0 ? <b className="green">+{fmt$(d.$(earned))}</b> : ""}</span>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

export function GroupSheet({ view, gid, me, go }) {
  const d = useDerived(view);
  const g = d.groups.find(x => x.id === gid);
  if (!g) return null;
  const close = () => go({ group: null });
  const s = d.stats(gid);
  const curKey = view.season?.currentWeek;
  const week = d.weeks.find(w => w.key === curKey);
  const games = (week?.games || []).filter(x => x.homeOwners?.[gid] > 0 || x.awayOwners?.[gid] > 0);
  const weekly = d.doneWeeks.map(w => ({ w, v: d.weekEarn(gid, w.key) }));
  const maxW = Math.max(1, ...weekly.map(x => x.v));
  return (
    <Sheet label={d.name(gid)} onClose={close}>
      <div className="shead" style={{ "--mine": d.color(gid) }}>
        <Crew d={d} gid={gid} me={me} size={40} />
        <div>
          <h2><GroupDot d={d} gid={gid} size={12} /> {d.name(gid)}</h2>
          <div className="dim">{ordinal(s.rank)} in money banked · {s.teams.length} teams · {+s.record.w.toFixed(1)}–{+s.record.l.toFixed(1)}{s.record.t ? `–${+s.record.t.toFixed(1)}` : ""} combined</div>
          {gid === me && <div className="small">This is you. <button className="tiny" onClick={() => { try { localStorage.removeItem("cc-me"); } catch {} location.reload(); }}>switch group</button></div>}
        </div>
      </div>
      <div className="tiles">
        <Tile label="Banked" value={fmt$(s.banked)} />
        <Tile label="Paid (net)" value={fmt$(s.netCost)} />
        <Tile label="Net today" value={fmtSigned$(s.todayNet)} tone={s.todayNet >= 0 ? "green" : "red"} />
        <Tile label="Projected net" value={fmtSigned$(s.projNet)} tone={s.projNet >= 0 ? "green" : "red"} sub={`${fmt$(s.projected)} projected earnings`} />
      </div>
      <h3>Roster</h3>
      <div className="tlist">
        {s.teams.map(t => {
          const stake = (d.owners[t]?.[gid] || 0) / 100, paid = d.paidFor(t, gid), proj = d.projected$(t) * stake;
          return (
            <button key={t} className="teamrow" onClick={() => go({ team: t, group: null })}>
              <img src={logo(t)} alt="" />
              <span className="tmain"><b>{moji(t)} {view.teams[t].name}</b><span className="dim small">{recStr(d.record(t))}{stake < 1 ? ` · ${fmtPct(stake * 100)} stake` : ""}</span></span>
              <span className="tnums">
                <span className="dim small">paid {fmt$(paid)} · banked {fmt$(d.banked$(t) * stake)}</span>
                <span className="small">proj. {fmt$(proj)} <b className={proj - paid >= 0 ? "green" : "red"}>({fmtSigned$(proj - paid)})</b></span>
              </span>
            </button>
          );
        })}
      </div>
      {games.length > 0 && (
        <>
          <h3>{week.label}</h3>
          <div className="gcards">{games.map(x => <GameCard key={x.id} d={d} g={x} me={me} go={go} />)}</div>
        </>
      )}
      {weekly.length > 0 && (
        <>
          <h3>Money by week</h3>
          <div className="wkbars">{weekly.map(({ w, v }) => (
            <div key={w.key} className="wkbar">
              <span className="dim small">{w.seasontype === 2 ? `Wk ${w.week}` : w.label}</span>
              <span className="wkbarline"><span style={{ width: `${(v / maxW) * 100}%`, background: d.color(gid) }} /></span>
              <b className="small">{fmt$(v)}</b>
            </div>
          ))}</div>
        </>
      )}
    </Sheet>
  );
}

// ---------------- PLAYOFF PICTURE ----------------
export function PlayoffPicture({ view, me, go }) {
  const d = useDerived(view);
  const st = view.nflStandings?.teams;
  if (!st) return null;
  return (
    <div className="pp">
      {["AFC", "NFC"].map(conf => {
        const rows = Object.entries(st).filter(([, x]) => x.conf === conf && x.seed).sort((a, b) => a[1].seed - b[1].seed).slice(0, 10);
        return (
          <div key={conf} className="ppcol">
            <h3>{conf}</h3>
            {rows.map(([t, x]) => (
              <React.Fragment key={t}>
                {x.seed === 8 && <div className="ppline dim small">— in the hunt —</div>}
                <button className={"pprow" + (x.seed > 7 ? " out" : "")} onClick={() => go({ team: t, group: null })}>
                  <span className="ppseed">{x.seed}</span><img src={logo(t)} alt="" /><b>{t}</b>
                  <span className="dim small">{x.wins}-{x.losses}{x.ties ? `-${x.ties}` : ""}</span>
                  <OwnerChips d={d} own={d.owners[t]} me={me} go={go} />
                  <span className="dim small pppct">{pctRound(d.vt(t).pPlayoffs ?? 0)}</span>
                </button>
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------------- RULES & PAYOUTS ----------------
export function Rules({ view, me, go }) {
  const d = useDerived(view);
  const P = d.P, pot = d.pot;
  const $ = w => (w / 100) * pot;
  const wc = (P.wcWin || 0) + (P.reachDiv || 0);
  const payouts = [
    ["Regular-season win", P.regWin, 272, "every win, all season"],
    ["Make the playoffs", P.berth, 14, "any playoff berth"],
    ["Wild Card win", wc, 8, "the 2 byes count as a win"],
    ["Divisional-round win", P.divWin, 4, ""],
    ["Conference title", P.confWin, 2, "win the AFC/NFC championship game"],
    ["Super Bowl win", P.sbWin, 1, ""]
  ];
  const ladder = [
    ["Miss the playoffs", 0],
    ["Make it, lose Wild Card", P.berth],
    ["Win Wild Card (or bye), lose Divisional", P.berth + wc],
    ["Lose the conference title game", P.berth + wc + P.divWin],
    ["Lose the Super Bowl", P.berth + wc + P.divWin + P.confWin],
    ["Win the Super Bowl", P.berth + wc + P.divWin + P.confWin + P.sbWin]
  ];
  const maxTeam = 17 * P.regWin + ladder[5][1];
  return (
    <div className="pad rules">
      <h1 className="pagetitle">Rules & payouts</h1>
      <p className="lede">Every win pays the group that owns the team. <b>{Math.round(P.regWin * 272)}% of the pot</b> goes to regular-season wins, the rest to the playoff run. Nothing is paid until after the Super Bowl.</p>

      <h2>💵 What everything pays</h2>
      <p className="dim small">Dollar amounts use the actual pot: <b>{fmt$(pot)}</b> (the total of all 32 auction prices).</p>
      <div className="tablewrap"><table className="tbl">
        <thead><tr><th>Event</th><th className="r">% of pot</th><th className="r">Pays</th><th className="r">Per season</th></tr></thead>
        <tbody>{payouts.map(([label, w, nTimes, note]) => (
          <tr key={label}><td>{label}{note && <div className="dim small">{note}</div>}</td><td className="r">{w}%</td><td className="r"><b>{fmt$($(w))}</b></td><td className="r dim">× {nTimes} = {fmt$($(w) * nTimes)}</td></tr>
        ))}</tbody>
      </table></div>

      <h2>🪜 What a playoff run adds</h2>
      <p className="dim small">On top of the team's regular-season wins. A #1 seed's bye counts as a Wild Card win, so it pays the same as winning that game.</p>
      <div className="ladder">{ladder.map(([label, w], i) => (
        <div key={label} className="rung" style={{ "--w": `${(w / ladder[5][1]) * 100}%` }}>
          <span className="rungbar" aria-hidden="true" /><span>{label}</span><b>{fmt$($(w))}</b>
        </div>
      ))}</div>
      <p className="dim small">Most any one team can earn: 17–0 plus a Super Bowl = {fmtPct(maxTeam)} of the pot ({fmt$($(maxTeam))}).</p>

      <h2>🧮 What would a team make?</h2>
      <Calculator d={d} view={view} me={me} go={go} />

      <h2>📜 The rules, short version</h2>
      <div className="rulecards">
        <div className="rulecard"><h3>Money</h3><ul>
          <li>{d.groups.length} groups, ${(d.config.groups[0]?.budget || 7000).toLocaleString()} cap each at the auction. The pot is the total of every winning bid: {fmt$(pot)}.</li>
          <li>No money moves during the season. After the Super Bowl each group settles once: <b>what your teams earned minus what you bid</b>, adjusted for trade cash. Earn more than you bid and you collect; less and you pay.</li>
          <li>Settlement happens within a week of the Super Bowl, by Venmo/Zelle, from Jamie & Dylan's numbers.</li>
        </ul></div>
        <div className="rulecard"><h3>Scoring</h3><ul>
          <li>Every regular-season win pays {fmt$($(P.regWin))} ({P.regWin}% of the pot) to whoever owns the team at kickoff.</li>
          <li>Playoff berth, each playoff win, the conference title and the Super Bowl pay the amounts above.</li>
          <li>Bye weeks pay nothing. The playoff bye for the two #1 seeds is credited as a Wild Card win.</li>
          <li>Ties aren't covered by the rules; this site counts a tie as no win (Jamie & Dylan have the final say).</li>
        </ul></div>
        <div className="rulecard"><h3>Trades</h3><ul>
          <li>Any group can sell all or part of a team to another group for cash both sides agree on. The cash goes group to group, not into the pot.</li>
          <li>Not retroactive: what a team already earned stays with the old owner. Only future earnings follow the new split.</li>
          <li>Both groups confirm the team, the percentage and the cash with Jamie & Dylan before it counts.</li>
          <li>Deadline: no trades once the conference championship matchups are set.</li>
        </ul></div>
      </div>
      <p className="dim small">This is a summary. Jamie & Dylan's official rules document and tracker win any dispute.</p>
    </div>
  );
}

function Calculator({ d, view, me, go }) {
  const P = d.P;
  const wc = (P.wcWin || 0) + (P.reachDiv || 0);
  const RUNS = [
    ["miss", "Missed the playoffs", 0],
    ["wc", "Lost in the Wild Card round", P.berth],
    ["div", "Lost in the Divisional round", P.berth + wc],
    ["conf", "Lost the conference title game", P.berth + wc + P.divWin],
    ["sb", "Lost the Super Bowl", P.berth + wc + P.divWin + P.confWin],
    ["champ", "Won the Super Bowl", P.berth + wc + P.divWin + P.confWin + P.sbWin]
  ];
  const [team, setTeam] = useState("");
  const [wins, setWins] = useState(10);
  const [run, setRun] = useState("miss");
  const pick = t => {
    setTeam(t);
    if (!t) return;
    setWins(Math.max(d.record(t).w, Math.min(17, Math.round(d.vt(t).expWins ?? d.record(t).w))));
    const p = d.vt(t).pPlayoffs ?? 0;
    setRun(p >= 0.5 ? "wc" : "miss");
  };
  const bonus = RUNS.find(r => r[0] === run)[2];
  const totalPct = wins * P.regWin + bonus;
  const total = d.$(totalPct);
  const sale = team ? view.state.auction.sales[team] : null;
  return (
    <div className="calc">
      <div className="calcrow">
        <label htmlFor="cteam">Team</label>
        <select id="cteam" value={team} onChange={e => pick(e.target.value)}>
          <option value="">Any team</option>
          {Object.keys(view.teams).sort().map(t => <option key={t} value={t}>{moji(t)} {view.teams[t].name}</option>)}
        </select>
      </div>
      <div className="calcrow">
        <label htmlFor="cwins">Regular-season wins: <b>{wins}</b></label>
        <input id="cwins" type="range" min="0" max="17" value={wins} onChange={e => setWins(Number(e.target.value))} />
      </div>
      <div className="calcrow">
        <label htmlFor="crun">Playoffs</label>
        <select id="crun" value={run} onChange={e => setRun(e.target.value)}>{RUNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <div className="calcout">
        <div><label>Total earned</label><b>{fmt$(total)}</b><span className="dim small">{fmtPct(totalPct)} of the pot · {wins} × {fmt$(d.$(P.regWin))}{bonus ? ` + ${fmt$(d.$(bonus))} playoffs` : ""}</span></div>
        {sale && <div><label>vs auction price ({fmt$(sale.amount)})</label><b className={total - sale.amount >= 0 ? "green" : "red"}>{fmtSigned$(total - sale.amount)}</b><span className="dim small">for {d.name(sale.group)}</span></div>}
      </div>
      {team && <p className="dim small">Prefilled with {view.teams[team].name}'s projected wins ({(d.vt(team).expWins ?? 0).toFixed(1)}) and {pctRound(d.vt(team).pPlayoffs ?? 0)} playoff odds. <button className="tiny" onClick={() => go({ team, group: null })}>team page →</button></p>}
    </div>
  );
}

// ---------------- who are you? ----------------
export function WhoAreYou({ view, me, onPick, onClose }) {
  const d = useDerived(view);
  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet who" role="dialog" aria-modal="true" aria-label="Pick your group" onClick={e => e.stopPropagation()}>
        <h2>Which group are you?</h2>
        <p className="dim small">Your group gets highlighted everywhere and "Your week" shows your games. Saved on this device only.</p>
        <div className="whogrid">
          {d.groups.map(g => (
            <button key={g.id} className={"whobtn" + (g.id === me ? " on" : "")} style={{ "--mine": d.color(g.id) }} onClick={() => onPick(g.id)}>
              <Crew d={d} gid={g.id} me={g.id} size={30} />
              <b>{d.name(g.id)}</b>
            </button>
          ))}
        </div>
        <button className="seg" onClick={() => onPick("none")}>Just browsing</button>
      </div>
    </div>
  );
}
