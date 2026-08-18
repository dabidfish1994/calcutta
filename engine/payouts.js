// Scoring profiles: the same simulated event probabilities priced under different payout rules.
// share (in % of pot) = linear combination of per-team event rates.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadProfiles(dataDir) {
  const p = path.join(dataDir || path.join(ROOT, "data"), "payout-profiles-2026.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return j;
}

export function resolveProfile(profilesJson, name) {
  const key = name || profilesJson.active;
  return { key, ...profilesJson.profiles[key] };
}

// rates: { expWins, pPlayoffs, pOneSeed, pWcWin, pDivWin, pConfWin, pSbWin, pDivTitle }
export function shareFromRates(p, r) {
  return (
    p.regWin * r.expWins +
    p.berth * r.pPlayoffs +
    p.oneSeed * r.pOneSeed +
    p.wcWin * r.pWcWin +
    p.reachDiv * (r.pWcWin + r.pOneSeed) + // reached divisional round = won WC game or had the bye
    p.divWin * r.pDivWin +
    p.confWin * r.pConfWin +
    p.sbWin * r.pSbWin +
    p.divTitle * r.pDivTitle
  );
}
