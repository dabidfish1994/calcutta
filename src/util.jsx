// Shared helpers for the viewer screens and the admin war room.
import { useEffect, useState } from "react";

export const fmt$ = n => "$" + Math.round(n).toLocaleString();
export const fmtSigned$ = n => (n >= 0 ? "+" : "−") + "$" + Math.abs(Math.round(n)).toLocaleString();
export const fmtPct = p => `${Math.round(p * 10) / 10}%`;
export const pctRound = p => `${Math.round(p * 100)}%`;
export const logo = abbr => `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;

// Every team gets a mascot. Non-negotiable.
export const MOJI = {
  BUF: "🦬", MIA: "🐬", NE: "🎩", NYJ: "✈️", BAL: "🐦‍⬛", CIN: "🐅", CLE: "🐶", PIT: "🛠️",
  HOU: "🤠", IND: "🐴", JAX: "🐆", TEN: "⚔️", DEN: "🐎", KC: "🏹", LV: "🎰", LAC: "⚡",
  DAL: "⭐", NYG: "🗽", PHI: "🦅", WSH: "🎖️", CHI: "🐻", DET: "🦁", GB: "🧀", MIN: "🪓",
  ATL: "🐦", NO: "⚜️", TB: "🏴‍☠️", CAR: "🐈‍⬛", ARI: "🌵", LAR: "🐏", SF: "⛏️", SEA: "🌊"
};
export const moji = t => MOJI[t] || "🏈";

// ---- admin passcode (edits + private tools) ----
export const getAdminKey = () => { try { return localStorage.getItem("cc-admin") || ""; } catch { return ""; } };
export const setAdminKey = k => { try { k ? localStorage.setItem("cc-admin", k) : localStorage.removeItem("cc-admin"); } catch {} };
export async function act(type, payload = {}) {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": getAdminKey() },
    body: JSON.stringify({ type, ...payload })
  });
  return res.json();
}

// ---- groups ----
export function shortName(name) {
  if (!name) return "?";
  const first = name.split(/[\s(/]+/)[0];
  return first.length > 8 ? first.slice(0, 8) : first;
}
// "Us (Fish/Joon/Gunther)" -> "Fish · Joon · Gunther"; "Mark/Fuller" -> "Mark · Fuller"
export function memberNames(name) {
  if (!name) return "?";
  const m = name.match(/\(([^)]+)\)/);
  const core = m ? m[1] : name;
  const parts = core.split(/[/,+&]+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts.join(" · ") : name;
}
export const groupName = (config, id) => config.groups.find(g => g.id === id)?.name || id;
// Identity colors, fixed by draft order (validated categorical set for the dark surface).
export const GROUP_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
export const colorOf = (config, gid) => {
  const i = config.groups.findIndex(g => g.id === gid);
  return i >= 0 ? GROUP_COLORS[i % GROUP_COLORS.length] : "#6b605d";
};

// ---- who is looking at the site (each friend picks their group) ----
export function useMe(view) {
  const [me, setMeState] = useState(() => { try { return localStorage.getItem("cc-me"); } catch { return null; } });
  const valid = me === "none" || view?.state?.config?.groups?.some(g => g.id === me);
  const setMe = v => { try { localStorage.setItem("cc-me", v); } catch {} setMeState(v); };
  return [valid ? (me === "none" ? null : me) : undefined, setMe]; // undefined = hasn't chosen yet
}

// ---- tiny hash router: #/tab/arg&team=LAR&group=g3 (shareable links) ----
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, ...kv] = h.split("&");
  const [tab, arg] = (path || "").split("/");
  const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
  const q = Object.fromEntries(kv.map(s => s.split("=")).filter(([k, v]) => k && v).map(([k, v]) => [k, dec(v)]));
  return { tab: tab || null, arg: arg ? dec(arg) : null, team: q.team || null, group: q.group || null };
}
export function useRoute() {
  const [r, setR] = useState(parseHash);
  useEffect(() => {
    const f = () => setR(parseHash());
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const go = next => {
    const m = { ...r, ...next };
    let h = "#/" + (m.tab || "week") + (m.arg ? "/" + encodeURIComponent(m.arg) : "");
    if (m.team) h += "&team=" + m.team;
    if (m.group) h += "&group=" + m.group;
    if (h !== location.hash) location.hash = h;
  };
  return [r, go];
}

// ---- games ----
export const kickoff = iso => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
export const dayLabel = iso => new Date(iso).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
export function gameStatus(g) {
  if (g.final) return "Final";
  if (g.state === "in") return g.shortDetail || "LIVE";
  if (g.state === "post") return g.shortDetail || "Canceled";
  if (g.timeValid === false) return new Date(g.date).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" }) + " · TBD";
  return kickoff(g.date);
}
export const recStr = r => (r ? `${r.w}-${r.l}${r.t ? `-${r.t}` : ""}` : "0-0");
export const owned = (own, gid) => (own?.[gid] || 0) > 0;
