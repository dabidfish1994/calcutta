// Automated futures odds from ESPN's public core API (DraftKings prices, no key needed):
// Super Bowl winner, both conference winners, all eight division winners.
// Missing from this feed: make-the-playoffs prices and win totals — the blend derives a
// playoff proxy from the division market, and win totals stay the preseason prior (the
// in-season model runs on actual results, so that's the right behavior anyway).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const YEAR = 2026;
const URL = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${YEAR}/futures?limit=100`;
const ID_TO_ABBR = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU"
};
const teamOf = ref => ID_TO_ABBR[Number(String(ref || "").match(/teams\/(\d+)/)?.[1])] || null;
const american = v => { const n = parseInt(String(v).replace(/[^-+\d]/g, ""), 10); return Number.isFinite(n) ? n : null; };

export async function fetchOdds() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`ESPN futures ${res.status}`);
  const json = await res.json();
  const out = { fetchedAt: new Date().toISOString(), provider: null, sb: {}, conf: {}, division: {} };
  for (const item of json.items || []) {
    const name = String(item.name || item.displayName || "");
    const bucket = /super bowl/i.test(name) ? "sb" : /conference/i.test(name) ? "conf" : /division/i.test(name) ? "division" : null;
    if (!bucket) continue;
    const fut = (item.futures || [])[0];
    if (!fut) continue;
    out.provider ??= fut.provider?.name || null;
    for (const b of fut.books || []) {
      const t = teamOf(b.team?.$ref), o = american(b.value);
      if (t && o != null) out[bucket][t] = o;
    }
  }
  const n = k => Object.keys(out[k]).length;
  if (n("sb") < 28 || n("division") < 28) throw new Error(`ESPN futures incomplete: sb=${n("sb")} div=${n("division")} conf=${n("conf")}`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchOdds().then(o => {
    console.log(`provider ${o.provider} · sb ${Object.keys(o.sb).length} · conf ${Object.keys(o.conf).length} · div ${Object.keys(o.division).length}`);
    console.log("LAR", o.sb.LAR, o.conf.LAR, o.division.LAR, "| ARI", o.sb.ARI, o.conf.ARI, o.division.ARI);
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
    fs.writeFileSync(path.join(dir, "market-odds-live.json"), JSON.stringify(o, null, 1));
  });
}
