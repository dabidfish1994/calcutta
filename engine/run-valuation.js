// CLI: refresh schedule, run the valuation, print the board, cache to data/valuation.json.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchAndCache } from "./fetch-schedule.js";
import { valuate } from "./sim.js";
import { TEAMS, TEAM_IDS } from "./teams.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const schedPath = path.join(DATA_DIR, "schedule-2026.json");

const sched = fs.existsSync(schedPath) && !process.argv.includes("--fresh")
  ? JSON.parse(fs.readFileSync(schedPath, "utf8"))
  : await fetchAndCache();
const winTotals = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "win-totals-2026.json"), "utf8"));

const val = valuate(sched.games, winTotals, 20000);
fs.writeFileSync(path.join(DATA_DIR, "valuation.json"), JSON.stringify(val, null, 1));

const rows = TEAM_IDS.map(t => ({ t, ...val.teams[t] })).sort((a, b) => b.share - a.share);
const totalShare = rows.reduce((s, r) => s + r.share, 0);
console.log(`\n${"TEAM".padEnd(26)} ${"E[W]".padStart(5)} ${"P(pl)".padStart(6)} ${"P(SB)".padStart(6)} ${"SHARE".padStart(7)}  $ @40k   $ @50k`);
for (const r of rows) {
  console.log(
    `${TEAMS[r.t].name.padEnd(26)} ${r.expWins.toFixed(1).padStart(5)} ${(r.pPlayoffs * 100).toFixed(0).padStart(5)}% ${(r.pSbWin * 100).toFixed(1).padStart(5)}% ${r.share.toFixed(2).padStart(6)}%  $${Math.round(r.share * 400).toString().padStart(5)}  $${Math.round(r.share * 500).toString().padStart(5)}`
  );
}
console.log(`\nTotal share: ${totalShare.toFixed(2)}% (payout weights sum to ~99.95%)`);
