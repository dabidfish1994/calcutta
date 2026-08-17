// Market layer: de-vig sportsbook futures and blend them into the simulated probabilities.
//
// The sim is fitted to win totals, so its regular-season side is already market-grade.
// Its playoff TAILS, though, are derived purely from ratings — this layer pulls them toward
// the actual futures markets (Super Bowl, make-the-playoffs, division winner), which carry
// information ratings flatten (QB ceiling, variance, path). Market weight decays as real
// games are played, because preseason futures go stale while the sim keeps learning.
import { TEAMS, TEAM_IDS, PAYOUT } from "./teams.js";

export const americanToProb = o => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));

const confTeams = conf => TEAM_IDS.filter(t => TEAMS[t].conf === conf);
const divTeams = (conf, div) => TEAM_IDS.filter(t => TEAMS[t].conf === conf && TEAMS[t].div === div);

// Scale a set of probabilities so they sum to `target` (removes vig / enforces structure).
function renorm(map, teams, target) {
  const sum = teams.reduce((s, t) => s + map[t], 0);
  if (sum <= 0) return;
  for (const t of teams) map[t] = (map[t] / sum) * target;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function blendMarket(simTeams, marketOdds, gamesPlayed) {
  // 70% market preseason, decaying linearly to 0 as the 272-game season completes.
  const wM = 0.7 * Math.max(0, (272 - gamesPlayed) / 272);

  // --- de-vig the three markets against their structural totals ---
  const mSb = {}, mPl = {}, mDiv = {};
  for (const t of TEAM_IDS) {
    const m = marketOdds[t] || {};
    mSb[t] = m.sb != null ? americanToProb(m.sb) : simTeams[t].pSbWin;
    mPl[t] = m.playoff != null ? americanToProb(m.playoff) : simTeams[t].pPlayoffs;
    mDiv[t] = m.division != null ? americanToProb(m.division) : simTeams[t].pDivTitle;
  }
  renorm(mSb, TEAM_IDS, 1);
  for (const conf of ["AFC", "NFC"]) renorm(mPl, confTeams(conf), 7);
  for (const conf of ["AFC", "NFC"]) for (const div of ["East", "North", "South", "West"])
    renorm(mDiv, divTeams(conf, div), 1);

  // --- blend the directly-marketed tails ---
  const pSb = {}, pPl = {}, pDivTitle = {};
  for (const t of TEAM_IDS) {
    pSb[t] = wM * mSb[t] + (1 - wM) * simTeams[t].pSbWin;
    pPl[t] = clamp(wM * mPl[t] + (1 - wM) * simTeams[t].pPlayoffs, 0, 0.99);
    pDivTitle[t] = wM * mDiv[t] + (1 - wM) * simTeams[t].pDivTitle;
  }
  renorm(pSb, TEAM_IDS, 1);
  for (const conf of ["AFC", "NFC"]) renorm(pPl, confTeams(conf), 7);
  for (const conf of ["AFC", "NFC"]) for (const div of ["East", "North", "South", "West"])
    renorm(pDivTitle, divTeams(conf, div), 1);

  // --- tilt the un-marketed rounds toward the SB adjustment, damped by round distance ---
  const pConf = {}, pDivRound = {}, pWc = {}, pOne = {};
  for (const t of TEAM_IDS) {
    const s = simTeams[t];
    const r = clamp(s.pSbWin > 1e-4 ? pSb[t] / s.pSbWin : 1, 0.25, 4);
    const q = clamp(s.pDivTitle > 1e-4 ? pDivTitle[t] / s.pDivTitle : 1, 0.25, 4);
    pConf[t] = s.pConfWin * Math.pow(r, 0.7);
    pDivRound[t] = s.pDivWin * Math.pow(r, 0.5);
    pWc[t] = s.pWcWin * Math.pow(r, 0.3);
    pOne[t] = s.pOneSeed * q;
  }
  for (const conf of ["AFC", "NFC"]) {
    renorm(pConf, confTeams(conf), 1);
    renorm(pDivRound, confTeams(conf), 2);
    renorm(pWc, confTeams(conf), 3);
    renorm(pOne, confTeams(conf), 1);
  }

  // --- final blended share per team ---
  const out = {};
  for (const t of TEAM_IDS) {
    const s = simTeams[t];
    const share =
      PAYOUT.regWin * s.expWins + PAYOUT.playoffBerth * pPl[t] + PAYOUT.oneSeed * pOne[t] +
      PAYOUT.wcWin * pWc[t] + PAYOUT.divWin * pDivRound[t] +
      PAYOUT.confWin * Math.max(pConf[t], pSb[t]) + PAYOUT.sbWin * pSb[t];
    out[t] = {
      ...s,
      shareSim: s.share,
      share,
      pPlayoffs: pPl[t],
      pOneSeed: pOne[t],
      pWcWin: pWc[t],
      pDivWin: pDivRound[t],
      pConfWin: Math.max(pConf[t], pSb[t]),
      pSbWin: pSb[t],
      pDivTitle: pDivTitle[t],
      market: {
        winTotal: marketOdds[t]?.winTotal ?? null,
        sbOdds: marketOdds[t]?.sb ?? null,
        playoffOdds: marketOdds[t]?.playoff ?? null,
        divisionOdds: marketOdds[t]?.division ?? null,
        pSb: mSb[t],
        pPlayoff: mPl[t],
        pDivTitle: mDiv[t]
      },
      sim: {
        pSb: simTeams[t].pSbWin,
        pPlayoff: simTeams[t].pPlayoffs,
        pDivTitle: simTeams[t].pDivTitle
      }
    };
  }
  return { teams: out, marketWeight: wM };
}
