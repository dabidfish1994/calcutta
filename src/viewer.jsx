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
function GameCard({ d, g, me }) {
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
    const banked = ((earnedByTeam[t] || 0) / 100) * pot * stake; // approx: assumes the stake was constant
    const projected = ((pt.totalShare || 0) / 100) * pot * stake;
    const paid = d.paidFor(t, gid);
    return (
      <div key={t} className={"spot" + (gid === me ? "" : " rival")}>
        <div className="spothead"><img src={logo(t)} alt="" /><div><b>{moji(t)} {teams[t].name}</b><div className="dim">{recStr(d.record(t))}{stake < 1 ? ` · ${fmtPct(stake * 100)} stake` : ""} · net cost {fmt$(paid)}</div></div></div>
        <div className="spotnums">
          <div><label>banked</label><b>{fmt$(banked)}</b></div>
          <div><label>projected</label><b>{fmt$(projected)}</b></div>
          <div><label>vs paid</label><b className={projected - paid >= 0 ? "green" : "red"}>{projected - paid >= 0 ? "+" : ""}{fmt$(projected - paid)}</b></div>
        </div>
      </div>
    );
  };
  const recap = week ? d.recap(week) : [];
  const games = (week?.games || []).filter(g => !onlyMine || g.homeOwners?.[me] > 0 || g.awayOwners?.[me] > 0);
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
              <tr key={g.id} className={g.id === me ? "hl" : ""}>
                <td>{memberNames(g.name)}</td>
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
        <h2>🧢 Your teams</h2>
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
          <div key={g.id} className="roster">
            <div className="rosterhead">
              <span className="rosteravatars">
                {membersOf(g.name).map(n => <Avatar key={n} name={n} title={n} size={22} mode={me ? "weak" : "hero"} />)}
              </span>
              <b>{memberNames(g.name)}</b>
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
          {recap.map((x, i) => <div key={i} className="recapline"><span>{x.icon}</span><span>{x.text}</span></div>)}
        </div>
      )}
      {me && week && (
        <div className="row" style={{ justifyContent: "flex-end", margin: ".4rem 0" }}>
          <button className={"seg" + (onlyMine ? " on" : "")} onClick={() => setOnlyMine(v => !v)}>{onlyMine ? "Showing my games" : "Only my games"}</button>
        </div>
      )}
      {byDay.map(day => (
        <div key={day.day}>
          <h3>{day.day}</h3>
          <div className="gcards">{day.games.map(g => <GameCard key={g.id} d={d} g={g} me={me} />)}</div>
        </div>
      ))}
      {week && !games.length && <p className="dim">None of your teams play this week.</p>}
    </div>
  );
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
      {team && <p className="dim small">Prefilled with {view.teams[team].name}'s projected wins ({(d.vt(team).expWins ?? 0).toFixed(1)}) and {pctRound(d.vt(team).pPlayoffs ?? 0)} playoff odds.</p>}
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
