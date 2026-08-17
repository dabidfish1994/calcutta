# Cardinal Calcutta War Room

Live draft console + season tracker for the Cardinal Calcutta (2026 NFL season).
Built to be near-zero-touch: it pulls the schedule and scores from ESPN's public API,
fits team ratings to sportsbook win totals, simulates the season 10–20k times
(regular season graph → playoff bracket), and reprices every unsold team live as the
auction unfolds.

## Run

```bash
npm install
npm run build
npm start          # http://localhost:4600
```

Everyone on the team opens the same URL (phone or laptop). State syncs over WebSocket.

On boot the server automatically: fetches the current schedule/results → refits ratings →
recomputes valuations. It re-syncs every 6 hours all season (and on the Season tab's
"Sync" button). The only manual input the system ever needs:

1. **Setup tab, once**: group names/count (I seeded 6 — fix when the league is final),
   which group is ours, prior pot guess, and the auction order (paste the commissioners'
   drawn order, or shuffle).
2. **Draft night**: tap who bid (amount auto-increments $25/$50 per the rules), tap SOLD.
   Everything else — pot re-estimation, fair prices, max-bid guidance, budget tracking — is automatic.
   Better: hit **🎙 Listen for bids** on the laptop that's on the Zoom call (Chrome, mic
   allowed, sound through speakers so it hears everyone). It live-transcribes the room,
   parses spoken amounts ("three fifty", "seven hundred", "$425"), and pops a
   confirmation card with the amount prefilled — one tap on the group that said it logs
   the bid. When it hears "sold" it prompts to confirm the sale to the top bidder.
   Nothing is ever logged without one of us confirming. Run the listener on ONE device
   only (suggestions are per-device; confirmed bids sync to everyone).
3. **Trades**: record them as they happen (the desk prices any partial stake for you).

## During the draft

- **Fair / max** = team's simulated pot-share × the live pot estimate. The pot estimate
  updates after every sale from the observed $-per-share-point rate, blended with your
  prior until ~25 share-points have sold.
- **Target** = fair × target margin (default 0.85) — the disciplined number to bid to.
- Card edge color: green = top bid below target (bid!), amber = between target and fair,
  red = above fair (walk away).
- The **heat badge** in the header shows whether the room is paying above or below
  pro-rata prices — if it's hot, every remaining team's fair price is higher than the
  static spreadsheet says.

## Updating inputs

- `data/win-totals-2026.json` — sportsbook win totals (edit any time; next sync refits).
- Valuation engine: `engine/sim.js`. Mid-season it Elo-updates ratings from real results
  and simulates only remaining games, so trade pricing stays current automatically.

## Fixing a badly-run auction on the fly

First-time auctioneers jump around, misspeak prices, and re-open teams. Everything is
correctable, live, from any device:

- **Every price is editable**: Board tab → ✎ on any sold team → change price or owner,
  or Reopen it entirely. On the Draft tab, ✎ next to the top bid corrects it; tapping
  the stepper amount lets you type any number.
- **Any team can be put on the block at any time**: Board tab → "▶ block" (handles an
  auctioneer going off-order); Skip and Undo cover the rest.
- The listener understands relative bids in context ("twenty five more", "bump it
  fifty" resolve against the current top bid) and guesses the bidding group when it
  hears a name it knows (set each group's member names as aliases in Setup).

## Transcript

Every finalized speech segment is saved server-side to `data/transcripts/YYYY-MM-DD.jsonl`
with timestamp, detected amounts, guessed group, and the team on the block — the
in-app Transcript panel (Draft tab) shows it live on every device, and it doubles as
the audit trail for any disputed price.

## Deploying for draft night

Any Node host works (Railway / Render / Fly, one service, port from `PORT` env,
persistent disk for `data/` recommended). Or run locally and share with
`npx localtunnel --port 4600` / Tailscale.

## Notes

- Payout weights are exactly the rules': 0.248% per regular-season win, 0.286% berth,
  0.5% #1 seed, 0.417% WC win, 1.25% divisional win, 3.75% conf championship, 12.5% SB.
- Playoff berth / #1 seed detection is inferred automatically from playoff participation
  (bye teams' first game is the divisional round).
- Ties award no win credit (rules are silent on ties).
- This mirrors the commissioners' tracker for our own decisions; Jamie & Dylan's numbers
  are official.
