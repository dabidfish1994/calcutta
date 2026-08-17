import React from "react";

// Hand-drawn cartoon characters. The three of us get bespoke looks; everyone else
// gets a deterministic character from their name, so avatars are stable everywhere.
const SKINS = ["#f0c9a8", "#e8b98f", "#d9a06d", "#b97f52", "#8d5a3a"];
const HAIRC = ["#171412", "#3a2a1e", "#6b4a2f", "#8a6238", "#4a4a52"];
const SHIRTS = ["#2e6b63", "#8c1515", "#31507d", "#7d5a31", "#4a3b6b", "#2f6b39", "#71372c", "#3a3f45"];
const STYLES = ["curly", "sidepart", "swept", "buzz", "shaggy", "cap"];

// Bespoke: keyed by lowercase first name. suit=true draws collar+jacket instead of crewneck.
const BESPOKE = {
  fish:    { skin: "#e8b98f", hair: "#2e2018", style: "curly",    shirt: "#2e6b63" },
  david:   { skin: "#e8b98f", hair: "#2e2018", style: "curly",    shirt: "#2e6b63" },
  dave:    { skin: "#e8b98f", hair: "#2e2018", style: "curly",    shirt: "#2e6b63" },
  gunther: { skin: "#f0c9a8", hair: "#6b4a2f", style: "sidepart", shirt: "#585d63", suit: true, tie: "#c76a8a" },
  joon:    { skin: "#f0c9a0", hair: "#14110f", style: "swept",    shirt: "#28344d", suit: true }
};

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function paramsFor(name) {
  const key = String(name || "?").trim().toLowerCase();
  if (BESPOKE[key]) return BESPOKE[key];
  const h = hashCode(key);
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRC[(h >> 3) % HAIRC.length],
    style: STYLES[(h >> 6) % STYLES.length],
    shirt: SHIRTS[(h >> 9) % SHIRTS.length],
    glasses: (h >> 12) % 5 === 0,
    beard: (h >> 14) % 6 === 0
  };
}

function Hair({ style, color }) {
  switch (style) {
    case "curly": return (
      <g fill={color}>
        <circle cx="22" cy="20" r="6.5" /><circle cx="28" cy="15.5" r="6.5" />
        <circle cx="36" cy="15.5" r="6.5" /><circle cx="42" cy="20" r="6.5" />
        <circle cx="45" cy="26" r="5" /><circle cx="19" cy="26" r="5" />
      </g>);
    case "sidepart": return (
      <path fill={color} d="M19 27 Q18 12 34 12 Q47 13 46 25 Q39 16 28 18 Q21 20 19 27 Z" />);
    case "swept": return (
      <path fill={color} d="M18 27 Q15 8 35 8 Q49 10 46 26 Q43 13 30 14 Q20 16 18 27 Z" />);
    case "buzz": return (
      <path fill={color} d="M19 25 Q20 14 32 14 Q44 14 45 25 Q39 19 32 19 Q25 19 19 25 Z" />);
    case "shaggy": return (
      <g fill={color}>
        <path d="M18 30 Q17 12 32 12 Q47 12 46 30 Q45 20 32 18 Q19 20 18 30 Z" />
        <rect x="17" y="26" width="4.5" height="9" rx="2" /><rect x="42.5" y="26" width="4.5" height="9" rx="2" />
      </g>);
    case "cap": return (
      <g>
        <path fill="#8c1515" d="M18 24 Q19 11 32 11 Q45 11 46 24 Z" />
        <rect x="14" y="22.5" width="24" height="4" rx="2" fill="#6d1010" />
      </g>);
    default: return null;
  }
}

// mode "hero": broad shoulders, big grin (us). mode "weak": scrawny, worried, sweating (everyone else).
export function Avatar({ name, size = 24, title, mode = "hero" }) {
  const p = paramsFor(name);
  const weak = mode === "weak";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title || name}>
      <title>{title || name}</title>
      <circle cx="32" cy="32" r="31" fill={p.shirt + "33"} stroke={p.shirt} strokeWidth="1" />
      <g transform={weak ? "translate(4.5 6.5) scale(0.86)" : undefined}>
        {p.suit ? (
          <g>
            <path d={weak ? "M20 64 Q20 49 32 49 Q44 49 44 64 Z" : "M11 64 Q11 45 32 45 Q53 45 53 64 Z"} fill={p.shirt} />
            <path d="M27 47 L32 55 L37 47 L34 46 L30 46 Z" fill="#f2efe9" />
            {p.tie && <path d="M31 48 L33 48 L34.5 57 L32 60 L29.5 57 Z" fill={p.tie} />}
          </g>
        ) : (
          <path d={weak ? "M20 64 Q20 49 32 49 Q44 49 44 64 Z" : "M11 64 Q11 45 32 45 Q53 45 53 64 Z"} fill={p.shirt} />
        )}
        <circle cx="18.5" cy="31" r="2.6" fill={p.skin} />
        <circle cx="45.5" cy="31" r="2.6" fill={p.skin} />
        <ellipse cx="32" cy="30" rx="13.5" ry="14.5" fill={p.skin} />
        <Hair style={p.style} color={p.hair} />
        <circle cx="26.5" cy="30.5" r="1.9" fill="#221a16" />
        <circle cx="37.5" cy="30.5" r="1.9" fill="#221a16" />
        {weak ? (
          <g stroke="#221a16" strokeWidth="1.3" fill="none" strokeLinecap="round">
            <path d="M24 27.5 Q26.5 25.8 29 27.2" transform="rotate(14 26.5 26.6)" />
            <path d="M35 27.2 Q37.5 25.8 40 27.5" transform="rotate(-14 37.5 26.6)" />
          </g>
        ) : (
          <g stroke="#221a16" strokeWidth="1.3" fill="none" strokeLinecap="round">
            <path d="M24 26.6 Q26.5 25.2 29 26.4" />
            <path d="M35 26.4 Q37.5 25.2 40 26.6" />
          </g>
        )}
        {weak
          ? <path d="M27 39.5 Q29.5 37.5 32 39.5 Q34.5 41.5 37 39.5" stroke="#93402e" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          : <path d="M26 36.5 Q32 43 38 36.5" stroke="#93402e" strokeWidth="2" fill="none" strokeLinecap="round" />}
        {weak && <path d="M46 20 Q49 24.5 46 26.5 Q43 24.5 46 20 Z" fill="#7db8d9" />}
        {p.glasses && (
          <g stroke="#221a16" strokeWidth="1.4" fill="none">
            <circle cx="26.5" cy="30.5" r="4.6" /><circle cx="37.5" cy="30.5" r="4.6" />
            <line x1="31.1" y1="30" x2="32.9" y2="30" />
          </g>
        )}
        {p.beard && <path d="M22 34 Q24 44 32 44.5 Q40 44 42 34 Q40 40.5 32 41 Q24 40.5 22 34 Z" fill={p.hair} opacity=".85" />}
      </g>
    </svg>
  );
}

// All member first names for a group config entry, e.g. "Us (Fish/Joon/Gunther)" -> ["Fish","Joon","Gunther"]
export function membersOf(groupName) {
  if (!groupName) return [];
  const m = groupName.match(/\(([^)]+)\)/);
  const core = m ? m[1] : groupName;
  return core.split(/[/,+&]+/).map(s => s.trim()).filter(Boolean);
}
