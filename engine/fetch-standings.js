// Live NFL standings from ESPN's public standings API: playoff seed "if the season ended today",
// streak, point differential, division record. Used for the playoff picture and team pages.
import { TEAMS } from "./teams.js";

const YEAR = 2026;
const URL = `https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=${YEAR}`;

export async function fetchStandings() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`ESPN standings ${res.status}`);
  const json = await res.json();
  const teams = {};
  for (const conf of json.children || []) {
    for (const e of conf.standings?.entries || []) {
      const abbr = e.team?.abbreviation;
      if (!TEAMS[abbr]) continue;
      const st = Object.fromEntries((e.stats || []).map(s => [s.name, s]));
      const num = k => (st[k]?.value != null ? Number(st[k].value) : null);
      const seed = num("playoffSeed");
      teams[abbr] = {
        conf: conf.abbreviation,
        seed: seed && seed <= 16 ? seed : null,
        wins: num("wins"), losses: num("losses"), ties: num("ties"),
        streak: st.streak?.displayValue || null,
        diff: num("pointDifferential"),
        pf: num("pointsFor"), pa: num("pointsAgainst"),
        divRecord: st.divisionRecord?.displayValue || null
      };
    }
  }
  if (Object.keys(teams).length < 30) throw new Error(`ESPN standings incomplete: ${Object.keys(teams).length} teams`);
  return { fetchedAt: new Date().toISOString(), teams };
}
