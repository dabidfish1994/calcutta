// Pulls the full 2026 NFL schedule + any played results from ESPN's public scoreboard API.
// Regular season: seasontype=2 weeks 1-18. Playoffs: seasontype=3 weeks 1,2,3,5 (4 = Pro Bowl).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TEAMS } from "./teams.js";

const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const YEAR = 2026;

async function fetchWeek(seasontype, week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${YEAR}&seasontype=${seasontype}&week=${week}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status} for st=${seasontype} wk=${week}`);
  const json = await res.json();
  return (json.events || []).map(e => {
    const comp = e.competitions[0];
    const home = comp.competitors.find(c => c.homeAway === "home");
    const away = comp.competitors.find(c => c.homeAway === "away");
    return {
      id: e.id,
      date: e.date,
      seasontype,
      week,
      home: home.team.abbreviation,
      away: away.team.abbreviation,
      homeScore: home.score != null ? Number(home.score) : null,
      awayScore: away.score != null ? Number(away.score) : null,
      neutral: comp.neutralSite === true,
      state: e.status?.type?.state || null,            // "pre" | "in" | "post"
      completed: e.status?.type?.completed === true,   // true for FINAL / FINAL_OT / FORFEIT
      final: e.status?.type?.completed === true,
      timeValid: comp.timeValid !== false,             // false = ESPN placeholder kickoff (TBD)
      shortDetail: e.status?.type?.shortDetail || null
    };
  });
}

export async function fetchSchedule(prev = null) {
  const games = [];
  for (let wk = 1; wk <= 18; wk++) games.push(...await fetchWeek(2, wk));
  for (const wk of [1, 2, 3, 5]) {
    try { games.push(...await fetchWeek(3, wk)); }
    catch (e) {
      // A transient failure must not erase a playoff week we already had — reuse the cached copy.
      const cached = (prev?.games || []).filter(g => g.seasontype === 3 && g.week === wk);
      if (cached.length) { console.warn(`playoff week ${wk} fetch failed, keeping cached copy:`, e.message); games.push(...cached); }
    }
  }
  const known = new Set(Object.keys(TEAMS));
  const unknown = games.filter(g => !known.has(g.home) || !known.has(g.away));
  if (unknown.length) console.warn("Unknown team abbreviations:", unknown.map(g => `${g.away}@${g.home}`));
  const regular = games.filter(g => g.seasontype === 2 && known.has(g.home) && known.has(g.away));
  if (regular.length !== 272) {
    const msg = `Expected 272 regular season games, got ${regular.length}`;
    if ((prev?.games || []).filter(g => g.seasontype === 2).length === 272) throw new Error(msg + " — keeping last good schedule");
    console.warn(msg);
  }
  return games.filter(g => known.has(g.home) && known.has(g.away));
}

export async function fetchAndCache() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `schedule-${YEAR}.json`), "utf8")); } catch {}
  const games = await fetchSchedule(prev);
  const out = { fetchedAt: new Date().toISOString(), year: YEAR, games };
  fs.writeFileSync(path.join(DATA_DIR, `schedule-${YEAR}.json`), JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchAndCache().then(o => {
    const finals = o.games.filter(g => g.final).length;
    console.log(`Cached ${o.games.length} games (${finals} final) to data/schedule-${YEAR}.json`);
  });
}
