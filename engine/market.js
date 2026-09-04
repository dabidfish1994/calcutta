// Market layer: de-vig sportsbook futures and blend them into the simulated probabilities.
//
// The sim is fitted to win totals, so its regular-season side is already market-grade.
// Its playoff TAILS, though, are derived purely from ratings — this layer pulls them toward
// the actual futures markets (Super Bowl, conference, division, make-the-playoffs), which carry
// information ratings flatten (QB ceiling, variance, path). Market weight decays as real games
// are played, because futures go stale while the sim keeps learning.
//
// Every team gets three shares: share (blended at the current weight), shareModel (sim only),
// shareMarket (tails fully market-driven) — the last two power the trade finder.
import { TEAMS, TEAM_IDS, PAYOUT } from "./teams.js";
import { shareFromRates } from "./payouts.js";

const PDF_PROFILE = { regWin: PAYOUT.regWin, berth: PAYOUT.playoffBerth, oneSeed: 0, wcWin: 0, reachDiv: PAYOUT.wcWin, divWin: PAYOUT.divWin, confWin: PAYOUT.confWin, sbWin: PAYOUT.sbWin, divTitle: 0 };

export const americanToProb = o => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const confTeams = conf => TEAM_IDS.filter(t => TEAMS[t].conf === conf);
const divTeams = (conf, div) => TEAM_IDS.filter(t => TEAMS[t].conf === conf && TEAMS[t].div === div);
const DIVS = ["East", "North", "South", "West"];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function renorm(map, teams, target) {
  const sum = teams.reduce((s, t) => s + map[t], 0);
  if (sum <= 0) return;
  for (const t of teams) map[t] = (map[t] / sum) * target;
}

// De-vigged market probabilities, with a division-derived proxy where a playoff price is missing.
function marketProbs(simTeams, marketOdds) {
  const mSb = {}, mDiv = {}, mConf = {}, mPl = {};
  const hasConf = TEAM_IDS.some(t => marketOdds[t]?.conf != null);
  for (const t of TEAM_IDS) {
    const m = marketOdds[t] || {};
    mSb[t] = m.sb != null ? americanToProb(m.sb) : simTeams[t].pSbWin;
    mDiv[t] = m.division != null ? americanToProb(m.division) : simTeams[t].pDivTitle;
    mConf[t] = m.conf != null ? americanToProb(m.conf) : simTeams[t].pConfWin;
  }
  renorm(mSb, TEAM_IDS, 1);
  for (const conf of ["AFC", "NFC"]) { renorm(mConf, confTeams(conf), 1); for (const d of DIVS) renorm(mDiv, divTeams(conf, d), 1); }
  for (const t of TEAM_IDS) {
    const m = marketOdds[t] || {};
    if (m.playoff != null) mPl[t] = americanToProb(m.playoff);
    else { // proxy: tilt the sim's playoff odds by how the market rates the team's division chances
      const q = clamp(simTeams[t].pDivTitle > 1e-3 ? mDiv[t] / simTeams[t].pDivTitle : 1, 0.25, 4);
      mPl[t] = clamp(simTeams[t].pPlayoffs * Math.sqrt(q), 0.001, 0.99);
    }
  }
  for (const conf of ["AFC", "NFC"]) renorm(mPl, confTeams(conf), 7);
  return { mSb, mDiv, mConf, mPl, hasConf };
}

function blendAt(simTeams, mk, wM, profile) {
  const { mSb, mDiv, mConf, mPl, hasConf } = mk;
  const pSb = {}, pPl = {}, pDivTitle = {}, pConf = {}, pDivRound = {}, pWc = {}, pOne = {};
  for (const t of TEAM_IDS) {
    const s = simTeams[t];
    pSb[t] = wM * mSb[t] + (1 - wM) * s.pSbWin;
    pPl[t] = clamp(wM * mPl[t] + (1 - wM) * s.pPlayoffs, 0, 0.99);
    pDivTitle[t] = wM * mDiv[t] + (1 - wM) * s.pDivTitle;
  }
  renorm(pSb, TEAM_IDS, 1);
  for (const conf of ["AFC", "NFC"]) { renorm(pPl, confTeams(conf), 7); for (const d of DIVS) renorm(pDivTitle, divTeams(conf, d), 1); }
  for (const t of TEAM_IDS) {
    const s = simTeams[t];
    const r = clamp(s.pSbWin > 1e-4 ? pSb[t] / s.pSbWin : 1, 0.25, 4);
    const q = clamp(s.pDivTitle > 1e-4 ? pDivTitle[t] / s.pDivTitle : 1, 0.25, 4);
    pConf[t] = hasConf ? wM * mConf[t] + (1 - wM) * s.pConfWin : s.pConfWin * Math.pow(r, 0.7);
    pDivRound[t] = s.pDivWin * Math.pow(r, 0.5);
    pWc[t] = s.pWcWin * Math.pow(r, 0.3);
    pOne[t] = s.pOneSeed * q;
  }
  for (const conf of ["AFC", "NFC"]) {
    renorm(pConf, confTeams(conf), 1); renorm(pDivRound, confTeams(conf), 2);
    renorm(pWc, confTeams(conf), 3); renorm(pOne, confTeams(conf), 1);
  }
  const out = {};
  for (const t of TEAM_IDS) {
    const s = simTeams[t];
    const conf = Math.max(pConf[t], pSb[t]);
    out[t] = {
      share: shareFromRates(profile, { expWins: s.expWins, pPlayoffs: pPl[t], pOneSeed: pOne[t], pWcWin: pWc[t], pDivWin: pDivRound[t], pConfWin: conf, pSbWin: pSb[t], pDivTitle: pDivTitle[t] }),
      pPlayoffs: pPl[t], pOneSeed: pOne[t], pWcWin: pWc[t], pDivWin: pDivRound[t], pConfWin: conf, pSbWin: pSb[t], pDivTitle: pDivTitle[t]
    };
  }
  return out;
}

export function blendMarket(simTeams, marketOdds, gamesPlayed, profile = PDF_PROFILE) {
  const wM = 0.7 * Math.max(0, (272 - gamesPlayed) / 272); // 70% preseason, decaying to 0
  const mk = marketProbs(simTeams, marketOdds);
  const cur = blendAt(simTeams, mk, wM, profile);
  const market = blendAt(simTeams, mk, 1, profile);
  const out = {};
  for (const t of TEAM_IDS) {
    const s = simTeams[t];
    out[t] = {
      ...s, ...cur[t],
      shareSim: s.share, shareModel: s.share, shareMarket: market[t].share,
      market: {
        winTotal: marketOdds[t]?.winTotal ?? null, sbOdds: marketOdds[t]?.sb ?? null, playoffOdds: marketOdds[t]?.playoff ?? null,
        divisionOdds: marketOdds[t]?.division ?? null, confOdds: marketOdds[t]?.conf ?? null,
        pSb: mk.mSb[t], pPlayoff: mk.mPl[t], pDivTitle: mk.mDiv[t], pConf: mk.mConf[t]
      },
      sim: { pSb: s.pSbWin, pPlayoff: s.pPlayoffs, pDivTitle: s.pDivTitle, pConf: s.pConfWin }
    };
  }
  return { teams: out, marketWeight: wM };
}
