// The 32 NFL teams, keyed by ESPN abbreviation.
export const TEAMS = {
  BUF: { name: "Buffalo Bills", conf: "AFC", div: "East" },
  MIA: { name: "Miami Dolphins", conf: "AFC", div: "East" },
  NE:  { name: "New England Patriots", conf: "AFC", div: "East" },
  NYJ: { name: "New York Jets", conf: "AFC", div: "East" },
  BAL: { name: "Baltimore Ravens", conf: "AFC", div: "North" },
  CIN: { name: "Cincinnati Bengals", conf: "AFC", div: "North" },
  CLE: { name: "Cleveland Browns", conf: "AFC", div: "North" },
  PIT: { name: "Pittsburgh Steelers", conf: "AFC", div: "North" },
  HOU: { name: "Houston Texans", conf: "AFC", div: "South" },
  IND: { name: "Indianapolis Colts", conf: "AFC", div: "South" },
  JAX: { name: "Jacksonville Jaguars", conf: "AFC", div: "South" },
  TEN: { name: "Tennessee Titans", conf: "AFC", div: "South" },
  DEN: { name: "Denver Broncos", conf: "AFC", div: "West" },
  KC:  { name: "Kansas City Chiefs", conf: "AFC", div: "West" },
  LV:  { name: "Las Vegas Raiders", conf: "AFC", div: "West" },
  LAC: { name: "Los Angeles Chargers", conf: "AFC", div: "West" },
  DAL: { name: "Dallas Cowboys", conf: "NFC", div: "East" },
  NYG: { name: "New York Giants", conf: "NFC", div: "East" },
  PHI: { name: "Philadelphia Eagles", conf: "NFC", div: "East" },
  WSH: { name: "Washington Commanders", conf: "NFC", div: "East" },
  CHI: { name: "Chicago Bears", conf: "NFC", div: "North" },
  DET: { name: "Detroit Lions", conf: "NFC", div: "North" },
  GB:  { name: "Green Bay Packers", conf: "NFC", div: "North" },
  MIN: { name: "Minnesota Vikings", conf: "NFC", div: "North" },
  ATL: { name: "Atlanta Falcons", conf: "NFC", div: "South" },
  CAR: { name: "Carolina Panthers", conf: "NFC", div: "South" },
  NO:  { name: "New Orleans Saints", conf: "NFC", div: "South" },
  TB:  { name: "Tampa Bay Buccaneers", conf: "NFC", div: "South" },
  ARI: { name: "Arizona Cardinals", conf: "NFC", div: "West" },
  LAR: { name: "Los Angeles Rams", conf: "NFC", div: "West" },
  SF:  { name: "San Francisco 49ers", conf: "NFC", div: "West" },
  SEA: { name: "Seattle Seahawks", conf: "NFC", div: "West" }
};

export const TEAM_IDS = Object.keys(TEAMS);

// Official Cardinal Calcutta payout weights, % of pot per occurrence (Section 4, revised Aug 2026).
// No #1-seed bonus; a playoff bye is credited as an automatic Wild Card win (8 WC credits per season).
export const PAYOUT = {
  regWin: 0.272,
  playoffBerth: 0.325,
  oneSeed: 0,
  wcWin: 0.55,   // applies to WC-game winners AND the two bye teams
  divWin: 1.25,
  confWin: 2.8,
  sbWin: 6.45
};
