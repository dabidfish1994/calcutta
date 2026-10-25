// The league-facing site: what every group sees week to week.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, membersOf } from "./avatars.jsx";
import {
  fmt$, fmtSigned$, fmtPct, pctRound, logo, moji, shortName, memberNames, groupName,
  colorOf, gameStatus, recStr, dayLabel, personalLink
} from "./util.jsx";

const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 >> 3) ^ 1 && n % 10] || "th");
// Makes a non-button element tappable (mouse, touch, keyboard).
const tapProps = fn => ({ role: "button", tabIndex: 0, onClick: fn, onKeyDown: e => e.key === "Enter" && fn() });
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

  // Butthole team of the week: worst record in a finished week. Ties go to more losses,
  // then fewer dollars that week, then lower in the season standings.
  function butthole(week) {
    if (!week || !isDone(week)) return null;
    const pct = r => r.w / (r.w + r.l);
    const row = weekTable(week).filter(r => r.w + r.l > 0)
      .sort((a, b) => pct(a) - pct(b) || b.l - a.l || a.earned - b.earned || bankedNow(a.gid) - bankedNow(b.gid))[0];
    if (!row) return null;
    let worst = null;
    for (const g of week.games) {
      if (!g.final || !g.winner) continue;
      const loser = g.winner === g.home ? g.away : g.home;
      if (!((g.winner === g.home ? g.awayOwners : g.homeOwners)?.[row.gid] > 0)) continue;
      const ls = loser === g.home ? g.homeScore : g.awayScore, ws = loser === g.home ? g.awayScore : g.homeScore;
      if (!worst || ws - ls > worst.margin) worst = { team: loser, opp: g.winner, ls, ws, margin: ws - ls };
    }
    return { ...row, worst, lastGame: week.games.reduce((m, g) => (g.date > m ? g.date : m), "") };
  }

  function recap(week) {
    const done = week.games.filter(g => g.final && g.winner);
    if (!done.length) return [];
    const tbl = weekTable(week).filter(r => r.w + r.l > 0);
    const out = [];
    const top = [...tbl].sort((a, b) => b.earned - a.earned)[0];
    if (top && top.earned > 0) out.push({ icon: "🏆", gid: top.gid, text: `${name(top.gid)} led ${week.label} with ${fmt$(top.earned)} (${fmtWL(top)})` });
    const bh = butthole(week);
    if (bh) out.push({ icon: "🍑", gid: bh.gid, butthole: true, text: `Butthole team of the week: ${name(bh.gid)} (${fmtWL(bh)})` });
    for (const r of tbl) if (r.l === 0 && r.w >= 2) out.push({ icon: "🧹", gid: r.gid, text: `${name(r.gid)} swept: ${fmtWL(r)}` });
    for (const r of tbl) if (r.w === 0 && r.l >= 1 && r.gid !== bh?.gid) out.push({ icon: "🥶", gid: r.gid, text: `${name(r.gid)} went ${fmtWL(r)}` });
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
      out.push({ icon: "⚔️", text: `${name(a)} vs ${name(b)}: ${best[1].n} head-to-heads, ${wa === wb ? `split ${wa}–${wb}` : `${wa > wb ? name(a) : name(b)} took ${Math.max(wa, wb)}–${Math.min(wa, wb)}`}` });
    }
    const i = doneWeeks.findIndex(w => w.key === week.key);
    if (i >= 1) {
      const before = rankAt(i), after = rankAt(i + 1);
      const climb = groups.map(g => ({ gid: g.id, d: before[g.id] - after[g.id] })).sort((a, b) => b.d - a.d)[0];
      if (climb && climb.d > 0) out.push({ icon: "📈", gid: climb.gid, text: `${name(climb.gid)} climbed from ${ordinal(before[climb.gid])} to ${ordinal(after[climb.gid])}` });
    }
    return out;
  }

  const bankedBy = (t, gid) => {
    let sum = 0;
    for (const w of weeks) for (const g of w.games) for (const c of g.credits || []) if (c.team === t) sum += c.credit * ((c.owners?.[gid] || 0) / 100);
    return $(sum);
  };
  const seedOf = t => nflStandings?.teams?.[t]?.seed || null;
  const eventsFor = t => events.filter(e => e.team === t);
  const gamesOf = t => weeks.flatMap(w => w.games.filter(g => g.home === t || g.away === t).map(g => ({ ...g, weekLabel: w.label, weekKey: w.key })));

  return {
    view, P, pot, config, groups, weeks, owners, $, color, name, short, vt, teamsOf, paidFor, record, banked$, projected$,
    doneWeeks, weekEarn, cum, stats, weekTable, recap, butthole, credit$, seedOf, eventsFor, gamesOf, isDone, rankLive, bankedBy
  };
}

// ---------------- small building blocks ----------------
export function GroupDot({ d, gid, size = 9 }) {
  return <span className="gdot" style={{ background: d.color(gid), width: size, height: size }} aria-hidden="true" />;
}
export function OwnerChips({ d, own, me }) {
  const entries = Object.entries(own || {}).filter(([, p]) => p > 0);
  if (!entries.length) return <span className="ochip none">unowned</span>;
  return <span className="ochips">{entries.map(([gid, p]) => (
    <span key={gid} className={"ochip" + (gid === me ? " me" : "")}>
      <GroupDot d={d} gid={gid} />{d.name(gid)}{p < 100 ? ` ${fmtPct(p)}` : ""}
    </span>
  ))}</span>;
}
function Crew({ d, gid, me, size = 20 }) {
  return <span className="crewav">{membersOf(groupName(d.config, gid)).map(n => (
    <Avatar key={n} name={n} title={n} size={size} mode={!me || gid === me ? "hero" : "weak"} />
  ))}</span>;
}

// ---------------- game card (scoreboard style) ----------------
function GameCard({ d, g, me, onTeam }) {
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
          <div key={r.team} className={"grow" + (won ? " won" : "") + (lost ? " lost" : "") + (onTeam ? " clickable" : "")}
            {...(onTeam ? tapProps(() => onTeam(r.team)) : {})}>
            <span className="gteam">
              <img src={logo(r.team)} alt="" /><b>{r.team}</b><span className="dim">{rec(r.team)}</span>
            </span>
            <OwnerChips d={d} own={r.own} me={me} />
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
        <div key={c.team} className="gfoot credit">+{fmt$(d.$(c.credit))} to <OwnerChips d={d} own={c.owners} me={me} /> <span className="dim">({c.team})</span></div>
      ))}
    </div>
  );
}
const ownerColor = (d, own) => { const top = Object.entries(own || {}).sort((a, b) => b[1] - a[1])[0]; return top ? d.color(top[0]) : "#4a403e"; };

// ---------------- SEASON (the original page, plus the week recap and new game cards) ----------------
export function Season({ view, me }) {
  const d = useDerived(view);
  const { state, teams, summaries, projections, season, earnedByTeam, scheduleFetchedAt, valuation } = view;
  const [syncing, setSyncing] = useState(false);
  const [wkSel, setWkSel] = useState(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [meme, setMeme] = useState(null); // "loss" (Bills) or a GROUP_MEMES group id
  const [teamPop, setTeamPop] = useState(null);
  const openTeam = setTeamPop;
  const jumpTo = gid => document.getElementById(gid === me ? "roster-me" : `roster-${gid}`)?.scrollIntoView({ block: "start" });
  // a group's meme switches on once its photo is uploaded (the Bills one always has its stats)
  const memeOf = gid => { const m = GROUP_MEMES[gid]; return m && (m.bills || view.meme?.[m.id]) ? m : null; };
  const openGroup = gid => (memeOf(gid) ? setMeme(gid) : jumpTo(gid));
  const lastBillsLoss = useMemo(() => d.weeks.flatMap(w => w.games)
    .filter(g => (g.home === "BUF" || g.away === "BUF") && g.final && g.winner && g.winner !== "BUF")
    .sort((a, b) => b.date.localeCompare(a.date))[0] || null, [d]);
  useEffect(() => { // every Bills loss gets one popup per device, for a week
    if (!lastBillsLoss || Date.now() - Date.parse(lastBillsLoss.date) > 7 * 86400e3) return;
    let seen = []; try { seen = JSON.parse(localStorage.getItem("cc-ff-seen") || "[]"); } catch {}
    if (seen.includes(lastBillsLoss.id)) return;
    try { localStorage.setItem("cc-ff-seen", JSON.stringify([...seen, lastBillsLoss.id].slice(-40))); } catch {}
    setMeme("loss");
  }, [lastBillsLoss?.id]);
  const [buttWeek, setButtWeek] = useState(null);
  const lastDone = d.doneWeeks[d.doneWeeks.length - 1];
  const lastButt = useMemo(() => d.butthole(lastDone), [d]);
  useEffect(() => { // butthole team of the week: once per device per finished week, after any Bills popup
    if (!lastButt || me === undefined || meme || teamPop || buttWeek || Date.now() - Date.parse(lastButt.lastGame) > 7 * 86400e3) return;
    let seen = []; try { seen = JSON.parse(localStorage.getItem("cc-bh-seen") || "[]"); } catch {}
    if (!seen.includes(lastDone.key)) setButtWeek(lastDone.key);
  }, [lastDone?.key, !!lastButt, me, meme, teamPop]);
  const closeButt = () => { // counts as seen once it's closed, so a reconnect mid-load can't swallow it
    try {
      const seen = JSON.parse(localStorage.getItem("cc-bh-seen") || "[]");
      if (!seen.includes(buttWeek)) localStorage.setItem("cc-bh-seen", JSON.stringify([...seen, buttWeek].slice(-30)));
    } catch {}
    setButtWeek(null);
  };
  const memeKey = JSON.stringify(view.meme || {});
  useEffect(() => { // warm the meme photos so a popup opens with its picture already loaded
    const timer = setTimeout(() => Object.entries(view.meme || {}).forEach(([id, v]) => { new Image().src = `/api/meme/${id}?v=${v}`; }), 2500);
    return () => clearTimeout(timer);
  }, [memeKey]);
  const pot = d.pot;
  const weeks = d.weeks;
  const curKey = wkSel || season?.currentWeek || weeks[0]?.key;
  const week = weeks.find(w => w.key === curKey);
  const proj = projections?.groups || {};
  const groups = [...d.groups].sort((a, b) => (proj[b.id]?.projectedNet ?? 0) - (proj[a.id]?.projectedNet ?? 0));
  const weekEarned = gid => d.weekEarn(gid, curKey);
  const nowWeek = weeks.find(w => w.key === season?.currentWeek);
  const owners = d.owners;
  const myTeams = me ? d.teamsOf(me) : [];
  const others = groups.filter(g => g.id !== me);
  const teamCard = (t, gid) => {
    const pt = projections?.teams?.[t] || {};
    const stake = (owners[t]?.[gid] || 0) / 100;
    const banked = d.bankedBy(t, gid); // trades aren't retroactive: credits follow ownership at each kickoff
    const projected = banked + ((pt.futureShare || 0) / 100) * pot * stake;
    const paid = d.paidFor(t, gid);
    const bills = t === "BUF";
    return (
      <div key={t} className={"spot clickable" + (gid === me ? "" : " rival")} {...tapProps(() => openTeam(t))}>
        <div className="spothead"><img src={logo(t)} alt="" /><div><b>{moji(t)} {teams[t].name}{bills ? " 💸" : ""}</b><div className="dim">{recStr(d.record(t))}{stake < 1 ? ` · ${fmtPct(stake * 100)} stake` : ""} · net cost {fmt$(paid)}</div></div></div>
        <div className="spotnums">
          <div><label>banked</label><b>{fmt$(banked)}</b></div>
          <div><label>projected</label><b>{fmt$(projected)}</b></div>
          <div><label>vs paid</label><b className={projected - paid >= 0 ? "green" : "red"}>{projected - paid >= 0 ? "+" : ""}{fmt$(projected - paid)}</b></div>
        </div>
      </div>
    );
  };
  const recap = week ? d.recap(week) : [];
  const mineOnly = onlyMine && !!me;
  const games = (week?.games || []).filter(g => !mineOnly || g.homeOwners?.[me] > 0 || g.awayOwners?.[me] > 0);
  const byDay = [];
  for (const g of games) { const k = dayLabel(g.date); const last = byDay[byDay.length - 1]; if (last?.day === k) last.games.push(g); else byDay.push({ day: k, games: [g] }); }

  return (
    <div className="pad">
      <div className="statline">
        <span>pot <b>{fmt$(pot)}</b>{nowWeek ? <> · now: <b>{nowWeek.label}</b></> : null}</span>
        <button disabled={syncing} onClick={async () => { setSyncing(true); await fetch("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {}); setSyncing(false); }}>
          {syncing ? "Syncing…" : "Sync scores now"}
        </button>
      </div>
      <p className="dim">Scores sync from ESPN every hour (last pull {scheduleFetchedAt ? new Date(scheduleFetchedAt).toLocaleString() : "—"}). Projected = banked so far + the engine's re-simulated remaining season, re-fit to real results.</p>

      <h2>🏆 Standings</h2>
      <div className="tablewrap"><table className="tbl">
        <thead><tr><th>Group</th><th className="r">Teams</th><th className="r">Banked</th><th className="r">Projected</th><th className="r">Net cost</th><th className="r">Proj. net</th><th className="r">{week?.label || "Week"}</th></tr></thead>
        <tbody>
          {groups.map(g => {
            const s = summaries[g.id]; const pj = proj[g.id] || {};
            return (
              <tr key={g.id} className={(g.id === me ? "hl" : "") + " clickable"} onClick={() => openGroup(g.id)}>
                <td>{memberNames(g.name)}{memeOf(g.id) ? ` ${memeOf(g.id).tag}` : ""}</td>
                <td className="r">{d.teamsOf(g.id).length}</td>
                <td className="r">{fmt$(s.earnedDollars)}</td>
                <td className="r">{fmt$(pj.projectedEarned || 0)}</td>
                <td className="r" title="auction spend minus trade cash received">{fmt$(s.spent - s.tradeCash)}</td>
                <td className={"r " + ((pj.projectedNet || 0) >= 0 ? "green" : "red")}><b>{(pj.projectedNet || 0) >= 0 ? "+" : ""}{fmt$(pj.projectedNet || 0)}</b></td>
                <td className="r">{weekEarned(g.id) ? fmt$(weekEarned(g.id)) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>

      {me && (<>
        <h2 id="roster-me">🧢 Your teams</h2>
        <div className="spots">
          {myTeams.map(t => teamCard(t, me))}
          {!myTeams.length && <p className="dim">No teams yet.</p>}
        </div>
      </>)}

      <h2>🔭 {me ? "Everyone else's teams" : "Everyone's teams"}</h2>
      <p className="dim">Every group's roster: what they bought, what they've banked, and what the model projects for them. Same standings order as above.</p>
      {others.map(g => {
        const held = d.teamsOf(g.id); const s = summaries[g.id]; const pj = proj[g.id] || {};
        return (
          <div key={g.id} className="roster" id={`roster-${g.id}`}>
            <div className="rosterhead">
              <span className="rosteravatars">
                {membersOf(g.name).map(n => <Avatar key={n} name={n} title={n} size={22} mode={me ? "weak" : "hero"} />)}
              </span>
              {memeOf(g.id)
                ? <button className="linkish" onClick={() => setMeme(g.id)}><b>{memberNames(g.name)} {memeOf(g.id).tag}</b></button>
                : <b>{memberNames(g.name)}</b>}
              <span className="dim">{held.length} team{held.length === 1 ? "" : "s"} · spent {fmt$(s.spent - s.tradeCash)} · banked {fmt$(s.earnedDollars)} · proj. net{" "}
                <b className={(pj.projectedNet || 0) >= 0 ? "green" : "red"}>{(pj.projectedNet || 0) >= 0 ? "+" : ""}{fmt$(pj.projectedNet || 0)}</b>
              </span>
            </div>
            <div className="spots">
              {held.map(t => teamCard(t, g.id))}
              {!held.length && <p className="dim">No teams.</p>}
            </div>
          </div>
        );
      })}

      <h2>📅 Week by week</h2>
      <div className="weeknav">
        {weeks.map(w => (
          <button key={w.key} className={(w.key === curKey ? "on" : "") + (w.key === season?.currentWeek ? " now" : "")} onClick={() => setWkSel(w.key)}>{w.label}</button>
        ))}
      </div>
      {recap.length > 0 && (
        <div className="recap">
          <h3>{week.label} recap</h3>
          {recap.map((x, i) => (
            <div key={i} className={"recapline" + (x.butthole ? " clickable" : "")} {...(x.butthole ? tapProps(() => setButtWeek(week.key)) : {})}>
              <span>{x.icon}</span><span>{x.text}</span>
            </div>
          ))}
        </div>
      )}
      {me && week && (
        <div className="row" style={{ justifyContent: "flex-end", margin: ".4rem 0" }}>
          <button className={"seg" + (mineOnly ? " on" : "")} onClick={() => setOnlyMine(v => !v)}>{mineOnly ? "Showing my games" : "Only my games"}</button>
        </div>
      )}
      {byDay.map(day => (
        <div key={day.day}>
          <h3>{day.day}</h3>
          <div className="gcards">{day.games.map(g => <GameCard key={g.id} d={d} g={g} me={me} onTeam={openTeam} />)}</div>
        </div>
      ))}
      {week && !games.length && <p className="dim">None of your teams play this week.</p>}
      {teamPop && <TeamTap view={view} team={teamPop} me={me} onClose={() => setTeamPop(null)} />}
      {meme === "loss" && <FatFinger view={view} d={d} reason="loss" onClose={() => setMeme(null)} />}
      {GROUP_MEMES[meme] && <GroupMeme view={view} d={d} gid={meme} onClose={() => setMeme(null)} onTeams={() => { setMeme(null); jumpTo(meme); }} />}
      {buttWeek && <ButtholeMeme view={view} d={d} week={weeks.find(w => w.key === buttWeek)} onClose={closeButt} onTeams={gid => { closeButt(); jumpTo(gid); }} />}
    </div>
  );
}

// ---------------- meme popups ----------------
function MemePopup({ label, img, alt, fit, fallback = "🫰", top, bottom, quote, cite, stats, foot, action, onClose }) {
  useEffect(() => {
    const f = e => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet meme-sheet" role="dialog" aria-modal="true" aria-label={label} onClick={e => e.stopPropagation()}>
        <div className={"meme" + (fit ? ` ${fit}` : "")}>
          {img ? <img src={img} alt={alt} /> : <div className="memefallback" aria-hidden="true">{fallback}</div>}
          {top && <span className="memetext top">{top}</span>}
          {bottom && <span className="memetext bottom">{bottom}</span>}
        </div>
        {quote && <blockquote className="memequote">“{quote}”<cite>{cite}</cite></blockquote>}
        <div className="memestats">{stats.map(([l, v, tone]) => <div key={l}><label>{l}</label><b className={tone || ""}>{v}</b></div>)}</div>
        {foot && <p className="small">{foot}</p>}
        {action && <button onClick={action.onClick}>{action.label}</button>}
        <button className="go" onClick={onClose}>😂 Close</button>
      </div>
    </div>
  );
}

// Sept 3, Calcutta Time chat: "That was an accidental fat finger."
function FatFinger({ view, d, reason, action, onClose }) {
  const sale = view.state.auction.sales.BUF;
  if (!sale) return null;
  const paid = sale.amount, P = d.P;
  const rec = d.record("BUF");
  const banked = d.banked$("BUF"), projected = d.projected$("BUF");
  const winPay = d.$(P.regWin), wc = (P.wcWin || 0) + (P.reachDiv || 0);
  const runs = [
    ["missing the playoffs", 0], ["a Wild Card exit", P.berth], ["a Divisional exit", P.berth + wc],
    ["losing the AFC title game", P.berth + wc + P.divWin], ["losing the Super Bowl", P.berth + wc + P.divWin + P.confWin],
    ["winning the Super Bowl", P.berth + wc + P.divWin + P.confWin + P.sbWin]
  ];
  const left = 17 - rec.w - rec.l - rec.t;
  const ways = runs.map(([label, w]) => ({ label, need: Math.max(0, Math.ceil((paid - d.$(w)) / winPay)) }))
    .filter(x => x.need <= rec.w + left);
  const breakEven = !ways.length ? "Mathematically impossible now."
    : ways[0].need <= rec.w ? "Win the Super Bowl and it's paid off."
      : ways.slice(0, 2).map(x => `${x.need}+ wins and ${x.label}`).join(", or ");
  const lost = reason === "loss";
  return (
    <MemePopup label="The Bills fat finger" onClose={onClose}
      img={view.meme?.buf ? `/api/meme/buf?v=${view.meme.buf}` : null}
      alt="The commissioner, moments after bidding $3,000 on the Bills"
      top={lost ? (rec.l > 1 ? "Bills lost again" : "Bills lost") : `Paid ${fmt$(paid)} for the Bills`}
      bottom={lost ? `Still paid ${fmt$(paid)}` : null}
      quote="That was an accidental fat finger." cite="dylan.burke, Calcutta Time chat, Sept 3"
      stats={[["Bills", recStr(rec)], ["Earned so far", fmt$(banked)], ["Projected season", fmt$(projected)],
        ["Cost of the extra zero", fmtSigned$(projected - paid), projected - paid >= 0 ? "green" : "red"]]}
      foot={<><b>To break even:</b> {breakEven}</>} action={action} />
  );
}

// Group memes: tap the group in the standings or on its roster header. Photos live on the
// server volume (POST /api/admin/meme/<id>), never in the repo.
const GROUP_MEMES = {
  g2: { bills: true, tag: "💸" }, // Dylan's group gets the fat-finger meme
  g3: { id: "war", tag: "🎖️", label: "Secretary of War", alt: "Breaking news: new Secretary of War named", fit: "full" }, // the picture is its own caption
  g4: { id: "fuller", tag: "🤵", label: "Fuller", alt: "Fuller in a tuxedo, checking the standings", top: `6'7"`, bottom: "Can't dunk" },
  g6: { id: "mike", tag: "🍼", label: "Mike", alt: "Mike in a hanbok and gat in Seoul", bottom: "Our wittle brother" }
};
function GroupMeme({ view, d, gid, onClose, onTeams }) {
  const m = GROUP_MEMES[gid];
  if (!m || !d.groups.some(x => x.id === gid)) return null;
  const action = { label: `See ${d.name(gid)}'s teams`, onClick: onTeams };
  if (m.bills) return <FatFinger view={view} d={d} reason="tap" action={action} onClose={onClose} />;
  const s = d.stats(gid);
  return (
    <MemePopup label={m.label} onClose={onClose}
      img={view.meme?.[m.id] ? `/api/meme/${m.id}?v=${view.meme[m.id]}` : null}
      alt={m.alt} fit={m.fit} top={m.top} bottom={m.bottom}
      stats={[["Money banked", fmt$(s.banked)], ["League rank", ordinal(s.rank)], ["Spent at auction", fmt$(s.netCost)],
        ["Projected net", fmtSigned$(s.projNet), s.projNet >= 0 ? "green" : "red"]]}
      foot={`${d.name(gid)}: ${s.teams.length} team${s.teams.length === 1 ? "" : "s"}, ${+s.record.w.toFixed(1)}–${+s.record.l.toFixed(1)} combined.`}
      action={action} />
  );
}

// Butthole team of the week (picture uploaded as meme "butt").
function ButtholeMeme({ view, d, week, onClose, onTeams }) {
  const bh = d.butthole(week);
  if (!bh) return null;
  const w = bh.worst;
  return (
    <MemePopup label="Butthole team of the week" onClose={onClose} fit="contain" fallback="🍑"
      img={view.meme?.butt ? `/api/meme/butt?v=${view.meme.butt}` : null} alt="Butthole emoji"
      top="Butthole team of the week" bottom={d.name(bh.gid)}
      stats={[[`${week.label} record`, fmtWL(bh)], ["Earned this week", fmt$(bh.earned)],
        ["Ugliest loss", w ? `${w.team} lost by ${w.margin}` : "—"], ["Season rank", ordinal(d.rankLive[bh.gid])]]}
      foot={`Worst record of ${week.label}. Ties go to more losses, then fewer dollars.`}
      action={{ label: `See ${d.name(bh.gid)}'s teams`, onClick: () => onTeams(bh.gid) }} />
  );
}

// ---------------- team popup ----------------
export function TeamPopup({ view, team: t, me, onClose, onTeam, back }) {
  const d = useDerived(view);
  useEffect(() => {
    const f = e => e.key === "Escape" && onClose();
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, [onClose]);
  const info = view.teams[t];
  if (!info) return null;
  const v = d.vt(t), st = view.nflStandings?.teams?.[t];
  const sale = view.state.auction.sales[t];
  const own = d.owners[t] || (sale ? { [sale.group]: 100 } : {});
  const banked = d.banked$(t), projected = d.projected$(t);
  const games = d.gamesOf(t);
  const seed = st?.seed ? (st.seed <= 7 ? `${info.conf} #${st.seed} seed if the season ended today` : `${ordinal(st.seed)} in the ${info.conf}, outside the playoff line`) : null;
  return (
    <div className="sheetback" onClick={onClose}>
      <div className="sheet team-sheet" role="dialog" aria-modal="true" aria-label={info.name} onClick={e => e.stopPropagation()}>
        {back && <button className="tiny tpback" onClick={back.go}>← {view.teams[back.team]?.name || back.team}</button>}
        <div className="tphead">
          <img src={logo(t)} alt="" />
          <div>
            <h2>{moji(t)} {info.name}</h2>
            <div className="dim small">{info.conf} {info.div} · {recStr(d.record(t))}{st?.streak && st.streak !== "-" ? ` · ${st.streak}` : ""}{st?.diff != null ? ` · ${st.diff > 0 ? "+" : ""}${st.diff} pt diff` : ""}</div>
            {seed && <div className="small">{seed}</div>}
          </div>
        </div>
        <div className="tpowner"><OwnerChips d={d} own={own} me={me} />{sale && <span className="dim small">bought for {fmt$(sale.amount)}</span>}</div>
        <div className="memestats">
          <div><label>Earned so far</label><b>{fmt$(banked)}</b></div>
          <div><label>Projected season</label><b>{fmt$(projected)}</b></div>
          {sale && <div><label>vs price paid</label><b className={projected - sale.amount >= 0 ? "green" : "red"}>{fmtSigned$(projected - sale.amount)}</b></div>}
          <div><label>Make playoffs</label><b>{pctRound(v.pPlayoffs ?? 0)}</b></div>
        </div>
        <h3>Schedule</h3>
        <div className="tsched">
          {games.map(g => {
            const home = g.home === t, opp = home ? g.away : g.home;
            const won = g.final && g.winner === t, lost = g.final && g.winner && g.winner !== t;
            const p = g.pHome == null ? null : home ? g.pHome : 1 - g.pHome;
            const earned = (g.credits || []).filter(c => c.team === t).reduce((sum, c) => sum + c.credit, 0);
            return (
              <div key={g.id} className={"tsrow" + (won ? " won" : "") + (lost ? " lost" : "") + (onTeam ? " clickable" : "")} {...(onTeam ? tapProps(() => onTeam(opp)) : {})}>
                <span className="dim small">{g.seasontype === 2 ? `Wk ${g.week}` : g.weekLabel}</span>
                <span className="tsopp">{home ? "vs" : "@"} <img src={logo(opp)} alt="" /> {opp}</span>
                <span className="tsres">
                  {g.final ? <><b>{won ? "W" : lost ? "L" : "T"}</b> {home ? `${g.homeScore}–${g.awayScore}` : `${g.awayScore}–${g.homeScore}`}</>
                    : g.state === "in" ? <span className="livepill">{gameStatus(g)}</span>
                      : <span className="dim">{p != null ? `${pctRound(p)} · ` : ""}{gameStatus(g)}</span>}
                </span>
                <span className="tsearn">{earned > 0 ? <b className="green">+{fmt$(d.$(earned))}</b> : ""}</span>
              </div>
            );
          })}
        </div>
        <button className="go" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// The Bills open the fat-finger meme; every other team opens its popup. Tapping an opponent
// in the schedule opens that team, with a back button to the one before.
export function TeamTap({ view, team, me, onClose }) {
  const d = useDerived(view);
  const [stack, setStack] = useState([team]);
  const t = stack[stack.length - 1], prev = stack[stack.length - 2];
  const goBack = () => setStack(s => s.slice(0, -1));
  if (t === "BUF") return <FatFinger view={view} d={d} reason="tap" onClose={prev ? goBack : onClose} />;
  return <TeamPopup key={t} view={view} team={t} me={me} onClose={onClose} onTeam={o => setStack(s => [...s, o])} back={prev && { team: prev, go: goBack }} />;
}

// For screens with team names in a table: const [tapTeam, teamPopup] = useTeamTap(view, me).
export function useTeamTap(view, me) {
  const [team, setTeam] = useState(null);
  return [setTeam, team && <TeamTap key={team} view={view} team={team} me={me} onClose={() => setTeam(null)} />];
}

// ---------------- RULES & PAYOUTS ----------------
export function Rules({ view, me }) {
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
      <Calculator d={d} view={view} />

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

function Calculator({ d, view }) {
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
    setWins(Math.max(d.record(t).w, Math.min(17, Math.round(d.vt(t).expWinsView ?? d.vt(t).expWins ?? d.record(t).w))));
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
      {team && <p className="dim small">Prefilled with {view.teams[team].name}'s projected wins ({(d.vt(team).expWinsView ?? d.vt(team).expWins ?? 0).toFixed(1)}) and {pctRound(d.vt(team).pPlayoffs ?? 0)} playoff odds.</p>}
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
        <p className="dim small">Your group gets highlighted everywhere and you can filter to your games. This browser remembers your pick.</p>
        <div className="whogrid">
          {d.groups.map(g => (
            <button key={g.id} className={"whobtn" + (g.id === me ? " on" : "")} style={{ "--mine": d.color(g.id) }} onClick={() => onPick(g.id)}>
              <Crew d={d} gid={g.id} me={g.id} size={30} />
              <b>{d.name(g.id)}</b>
            </button>
          ))}
        </div>
        <button className="seg" onClick={() => onPick("none")}>Just browsing</button>
        {me && <CopyLink gid={me} name={d.name(me)} />}
      </div>
    </div>
  );
}

function CopyLink({ gid, name }) {
  const [done, setDone] = useState(false);
  return (
    <p className="dim small">
      Send your group its own link so nobody has to pick:{" "}
      <button className="tiny" onClick={async () => {
        try { await navigator.clipboard.writeText(personalLink(gid)); setDone(true); setTimeout(() => setDone(false), 1800); } catch {}
      }}>{done ? "Copied" : `Copy ${name}'s link`}</button>
    </p>
  );
}
