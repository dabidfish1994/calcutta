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
recomputes valuations. It re-syncs every 6 hours all season. Set `DATA_DIR` to put runtime
state on a persistent volume (Railway/Fly); it seeds itself from the repo's `data/` folder.

## Draft night — the dynamic flow

There is **no draft order to configure**. Hit **🏈 Start draft**, tap **🎙 Listen to the
draft** on the laptop that's on the Zoom call (Chrome, mic allowed, audio through
speakers), and the app follows the room:

1. **Team detection** — when the auctioneer names a team ("next up, the Broncos", "alright,
   niners"), the app recognizes it (nicknames included) and puts it on the block itself,
   with a 5-second undo pill. Genuinely ambiguous calls ("New York…") pop a two-button
   choice instead of guessing.
2. **Bid capture** — spoken amounts ("three fifty", "$425", and relative raises like
   "bump it fifty") pop a confirm card with the price prefilled; if it hears a name it
   knows (set member names as **aliases** per group in Setup) the group is prefilled too,
   so confirming is one tap. Nothing is logged unconfirmed.
3. **Sold** — hearing "sold" pops a confirm card for the top bid; one tap closes the sale,
   clears the block, reprices the board, and goes back to listening for the next team.

Backups for every step: a type-what-was-said box (same pipeline as the mic), a
put-a-team-on-the-block picker, tap-to-block on the Best remaining strip (only while the
block is empty, so a stray tap can't hijack live bidding), and manual bid buttons.

- **Fair / max** = team's simulated pot-share × the live pot estimate (re-estimated after
  every sale from observed prices, blended with your prior until ~25 share-points sold).
- **Target** = fair × target margin (default 0.85) — the disciplined number.
- Card edge: green = under target (bid), amber = between target and fair, red = walk.
- The header heat badge (🔥/🧊) shows if the room is paying above/below pro-rata.

## Fixing a badly-run auction on the fly

- **Every price is editable**: Board → ✎ on any sold team → change price/owner, or Reopen.
  On the block, ✎ corrects the top bid; tapping the stepper amount lets you type any number.
- **Any team, any time**: Board → "▶ block"; ✕ on the block card clears a wrong team;
  Skip and Undo cover the rest.
- Run the listener on ONE device only (suggestions are per-device; confirmed actions sync
  to everyone instantly).

## Transcript

Every finalized speech line is saved to `data/transcripts/YYYY-MM-DD.jsonl` with timestamp,
detected amounts, guessed group, and the team on the block. The Transcript panel (Draft tab)
shows it live on all devices — it's the audit trail for any disputed price.

## Odds — automatic from ESPN

Super Bowl, conference, and division futures refresh **daily** from ESPN's public futures feed
(`engine/fetch-odds.js`, DraftKings prices, no key) into `data/market-odds-live.json` and
overlay the preseason snapshot; a change to any input re-runs the simulation. ESPN carries no
make-the-playoffs market, so that probability is derived from the division market. Win totals
stay the preseason prior (the in-season model runs on results). Scores pull hourly from ESPN's
public scoreboard (`engine/fetch-schedule.js`).

## Trade finder

The Trades tab compares two values for every team's *remaining* season: **model** (results +
schedule simulation, market weight decaying to zero by Week 18) and **market** (the same sim
with playoff tails fully driven by today's futures — the number a rival looking at Vegas will
anchor on). Rivals' teams where model > market by ≥ $75 and ≥ 8% are buy targets with an
"offer up to" (85% of model value, never above market) and a walk-away; our teams where
market > model are sell candidates with an ask. "Draft offer" prefills the trade form.

## Odds tab — market lines, blended in

The Odds tab shows every team's sportsbook lines (win-total O/U, make-the-playoffs price,
division-winner price, Super Bowl futures) next to the model's numbers, plus the most
likely playoff matchups by round from the simulations. The lines aren't just displayed —
they're **factored in**: the engine de-vigs each futures market against its structural
total (SB sums to 100%, 7 berths per conference, 1 winner per division) and blends it
into the sim at 70% market weight preseason, decaying to 0 as real games are played.
Un-marketed rounds (conference/divisional/wild-card win rates) get tilted toward the SB
adjustment and renormalized. ⚡ flags teams where market and model genuinely disagree —
those are the auction edges. Lines live in `data/market-odds-2026.json`; edit and re-sync
to refresh.

## Season mode

Scores sync from ESPN automatically (boot + every 6h + manual button). Wins credit to
whoever owned the team at the time — partial-stake trades included (Trade desk prices any
slice from the live simulation). The Season tab mirrors the commissioners' net-settlement
math; Jamie & Dylan's numbers are official.

## Deploying (Railway)

One service, no database add-on needed:

1. Railway → New Project → Deploy from GitHub repo (`dabidfish1994/calcutta`).
2. It auto-detects Node: `npm install && npm run build`, start = `npm start`.
3. Add a **volume** mounted at e.g. `/data` and set env `DATA_DIR=/data` so auction state
   survives redeploys.
4. Generate a public domain in Settings → share that URL with Joon + Gunther.

Local + `npx localtunnel --port 4600` or Tailscale also works fine for draft night.

## Updating inputs

- `data/win-totals-2026.json` — sportsbook win totals (edit any time; next sync refits).
- Engine: `engine/sim.js`. Mid-season it Elo-updates ratings from real results and
  simulates only remaining games, so valuations and trade pricing stay current.

## Notes

- Payout weights follow the revised rules (Aug 2026): 0.272% per regular-season win (74%
  of pot), 0.325% berth, 0.55% Wild Card win — credited to the 6 WC winners AND the 2 bye
  teams — 1.25% divisional win, 2.8% conf championship, 6.45% SB. No #1-seed bonus; max
  16% per team. Scoring profiles live in `data/payout-profiles-2026.json` (Setup tab
  switches; the superseded v1 weights and Calcutta Time's default config are kept for reference).
- Playoff berth / bye detection is inferred from playoff participation (bye teams' first
  game is the divisional round). Ties award no win credit (rules are silent).
- Speech uses the browser's Web Speech API — no API keys; in Chrome the audio is processed
  by Google's speech service.
