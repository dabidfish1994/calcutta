// The graph engine: schedule graph -> Monte Carlo seasons -> playoff bracket DAG -> payout shares.
//
// Ratings are Elo-style. Preseason ratings are fitted so each team's expected win count over its
// actual 272-game schedule matches its sportsbook win total. In season, ratings update from real
// results (standard Elo, k=25) and only the remaining games are simulated — that is the
// mid-season repricing. Everything derives from two inputs: the schedule cache and win totals.
import { TEAMS, TEAM_IDS, PAYOUT } from "./teams.js";
import { blendMarket } from "./market.js";

const HFA = 40; // home-field advantage in Elo points (~55.7% for even teams)
const ELO_K = 25;

// Bump when the valuation schema/logic changes so cached valuation.json files recompute on deploy.
export const VALUATION_VERSION = 2;

export function winProb(rA, rB, hfaA) {
  return 1 / (1 + Math.pow(10, -((rA + hfaA - rB) / 400)));
}

function expectedWins(ratings, games) {
  const exp = Object.fromEntries(TEAM_IDS.map(t => [t, 0]));
  for (const g of games) {
    const p = winProb(ratings[g.home], ratings[g.away], g.neutral ? 0 : HFA);
    exp[g.home] += p;
    exp[g.away] += 1 - p;
  }
  return exp;
}

// Fit ratings so expected wins match sportsbook totals over the real schedule.
export function fitRatings(regularGames, winTotals) {
  const ratings = Object.fromEntries(TEAM_IDS.map(t => [t, 1500]));
  for (let iter = 0; iter < 400; iter++) {
    const exp = expectedWins(ratings, regularGames);
    let maxErr = 0;
    for (const t of TEAM_IDS) {
      const err = winTotals[t] - exp[t];
      maxErr = Math.max(maxErr, Math.abs(err));
      ratings[t] += 16 * err;
    }
    const mean = TEAM_IDS.reduce((s, t) => s + ratings[t], 0) / 32;
    for (const t of TEAM_IDS) ratings[t] -= mean - 1500;
    if (maxErr < 0.001) break;
  }
  return ratings;
}

// Update fitted ratings with actual played results (mid-season repricing input).
export function eloUpdate(baseRatings, playedGames) {
  const r = { ...baseRatings };
  const sorted = [...playedGames].sort((a, b) => a.date.localeCompare(b.date));
  for (const g of sorted) {
    if (!g.final || g.homeScore == null) continue;
    const p = winProb(r[g.home], r[g.away], g.neutral ? 0 : HFA);
    const homeWon = g.homeScore > g.awayScore ? 1 : g.homeScore < g.awayScore ? 0 : 0.5;
    r[g.home] += ELO_K * (homeWon - p);
    r[g.away] -= ELO_K * (homeWon - p);
  }
  return r;
}

function simGame(ratings, home, away, neutral) {
  const p = winProb(ratings[home], ratings[away], neutral ? 0 : HFA);
  return Math.random() < p ? home : away;
}

function seedConference(conf, wins, ratings) {
  // Approximate NFL tiebreakers with a small random jitter (coin-flip-ish) plus rating as a nudge.
  const key = t => wins[t] + Math.random() * 0.02 + ratings[t] * 1e-6;
  const byDiv = {};
  for (const t of TEAM_IDS) {
    if (TEAMS[t].conf !== conf) continue;
    (byDiv[TEAMS[t].div] ??= []).push(t);
  }
  const divWinners = Object.values(byDiv)
    .map(ts => ts.reduce((a, b) => (key(a) > key(b) ? a : b)))
    .sort((a, b) => key(b) - key(a));
  const rest = TEAM_IDS.filter(t => TEAMS[t].conf === conf && !divWinners.includes(t))
    .sort((a, b) => key(b) - key(a));
  return [...divWinners, ...rest.slice(0, 3)]; // seeds 1-7
}

function simPlayoffs(seeds, ratings, tally, rec) {
  // seeds: array of 7, index 0 = 1-seed. Returns conference champion.
  for (const t of seeds) tally[t].berth++;
  tally[seeds[0]].oneSeed++;
  for (const t of seeds.slice(0, 4)) tally[t].divTitle++;
  const wc = [
    [seeds[1], seeds[6]],
    [seeds[2], seeds[5]],
    [seeds[3], seeds[4]]
  ].map(([hi, lo]) => {
    rec("wc", hi, lo);
    const w = simGame(ratings, hi, lo, false);
    tally[w].wcWin++;
    return w;
  });
  const remaining = [seeds[0], ...wc].sort((a, b) => seeds.indexOf(a) - seeds.indexOf(b));
  const divWinners = [
    [remaining[0], remaining[3]],
    [remaining[1], remaining[2]]
  ].map(([hi, lo]) => {
    rec("div", hi, lo);
    const w = simGame(ratings, hi, lo, false);
    tally[w].divWin++;
    return w;
  });
  const [a, b] = divWinners.sort((x, y) => seeds.indexOf(x) - seeds.indexOf(y));
  rec("conf", a, b);
  const champ = simGame(ratings, a, b, false);
  tally[champ].confWin++;
  return champ;
}

// Simulate the season nSims times. actualWins/playedGames reflect what already happened;
// futureGames are simulated. Returns per-team probabilities, expected wins, and pot shares.
export function simulate({ ratings, futureGames, actualWins = null, nSims = 10000 }) {
  const base = () => ({ wins: 0, berth: 0, oneSeed: 0, divTitle: 0, wcWin: 0, divWin: 0, confWin: 0, sbWin: 0 });
  const tally = Object.fromEntries(TEAM_IDS.map(t => [t, base()]));
  const shareSamples = Object.fromEntries(TEAM_IDS.map(t => [t, []]));
  const matchCounts = new Map();
  const rec = (round, hi, lo) => {
    const key = `${round}:${lo}@${hi}`;
    matchCounts.set(key, (matchCounts.get(key) || 0) + 1);
  };

  for (let s = 0; s < nSims; s++) {
    const wins = Object.fromEntries(TEAM_IDS.map(t => [t, actualWins ? actualWins[t] : 0]));
    const simTally = Object.fromEntries(TEAM_IDS.map(t => [t, base()]));
    for (const g of futureGames) wins[simGame(ratings, g.home, g.away, g.neutral)]++;
    const afc = seedConference("AFC", wins, ratings);
    const nfc = seedConference("NFC", wins, ratings);
    const champA = simPlayoffs(afc, ratings, simTally, rec);
    const champN = simPlayoffs(nfc, ratings, simTally, rec);
    rec("sb", ...[champA, champN].sort());
    const sb = simGame(ratings, champA, champN, true);
    simTally[sb].sbWin++;

    for (const t of TEAM_IDS) {
      const st = simTally[t];
      tally[t].wins += wins[t];
      for (const k of ["berth", "oneSeed", "divTitle", "wcWin", "divWin", "confWin", "sbWin"]) tally[t][k] += st[k];
      const share =
        PAYOUT.regWin * wins[t] + PAYOUT.playoffBerth * st.berth + PAYOUT.oneSeed * st.oneSeed +
        PAYOUT.wcWin * st.wcWin + PAYOUT.divWin * st.divWin +
        PAYOUT.confWin * st.confWin + PAYOUT.sbWin * st.sbWin;
      shareSamples[t].push(share);
    }
  }

  const out = {};
  for (const t of TEAM_IDS) {
    const samples = shareSamples[t].sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / nSims;
    out[t] = {
      expWins: tally[t].wins / nSims,
      pPlayoffs: tally[t].berth / nSims,
      pOneSeed: tally[t].oneSeed / nSims,
      pDivTitle: tally[t].divTitle / nSims,
      pWcWin: tally[t].wcWin / nSims,
      pDivWin: tally[t].divWin / nSims,
      pConfWin: tally[t].confWin / nSims,
      pSbWin: tally[t].sbWin / nSims,
      share: mean,
      shareP10: samples[Math.floor(nSims * 0.1)],
      shareP90: samples[Math.floor(nSims * 0.9)]
    };
  }
  const matchups = {};
  for (const round of ["wc", "div", "conf", "sb"]) {
    matchups[round] = [...matchCounts.entries()]
      .filter(([k]) => k.startsWith(round + ":"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => {
        const [away, home] = k.slice(round.length + 1).split("@");
        return { away, home, p: n / nSims };
      });
  }
  return { teams: out, matchups };
}

// Full pipeline from raw inputs. Played games feed both Elo updates and banked wins;
// remaining games get simulated. Preseason this is simply the whole schedule.
export function valuate(scheduleGames, winTotals, nSims = 10000, marketOdds = null) {
  const regular = scheduleGames.filter(g => g.seasontype === 2);
  const played = regular.filter(g => g.final && g.homeScore != null);
  const future = regular.filter(g => !g.final);
  const preseason = fitRatings(regular, winTotals);
  const ratings = played.length ? eloUpdate(preseason, played) : preseason;
  const actualWins = Object.fromEntries(TEAM_IDS.map(t => [t, 0]));
  for (const g of played) {
    if (g.homeScore > g.awayScore) actualWins[g.home]++;
    else if (g.awayScore > g.homeScore) actualWins[g.away]++;
    else { actualWins[g.home] += 0.5; actualWins[g.away] += 0.5; }
  }
  const sim = simulate({ ratings, futureGames: future, actualWins, nSims });
  let teams = sim.teams;
  let marketWeight = 0;
  if (marketOdds) {
    for (const t of TEAM_IDS) if (marketOdds[t]) marketOdds[t].winTotal = winTotals[t];
    const blended = blendMarket(sim.teams, marketOdds, played.length);
    teams = blended.teams;
    marketWeight = blended.marketWeight;
  }
  return { version: VALUATION_VERSION, computedAt: new Date().toISOString(), gamesPlayed: played.length, ratings, teams, matchups: sim.matchups, marketWeight };
}
