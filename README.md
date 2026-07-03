# Tong-its Online

Free, unranked, **online multiplayer Tong-its** (the Filipino three-player rummy),
built to run entirely on Cloudflare's **free tier**. Server-authoritative, no
accounts, no coins, no ranks — open a table and play, or find people in the lobby.

**Live:** https://tongits.playy.online &nbsp;·&nbsp; mirror: https://vs.nullsec.online

> Status: playable and feature-rich. Core rules, the full draw/challenge
> showdown, a real-time lobby with world chat and presence, mobile support, and
> two card looks are all in. Newest work: a full visual redesign (“Gabi ng Tong-its”), sound + haptics, a local record/streak strip, hand sorting, PWA install, and a tabbed mobile lobby.

---

## What it is

Tong-its is a 3-player rummy where you race to clear your hand into melds (sets
and runs), lay off (**sapaw**) onto exposed melds, and either go out completely
(**Tongits**) or **call a draw** and win the showdown on the lowest points. This
is a faithful online version of a single-player game, rebuilt so people can play
each other in real time from a browser or phone — no installs.

---

## How it's built

Everything fits on Cloudflare's free plan: static assets for the client, one
Worker as the front door, one **SQLite-backed Durable Object per room** (game
state, WebSocket Hibernation, turn timers), and a single global **Lobby hub**
Durable Object that serves the room directory *and* real-time presence + world
chat over WebSockets.

```
browser ─ HTTP /api/*  ───────────┐
        ─ WS  /ws?room= (game) ───┼─▶ Worker ─▶ Room DO   (one per room)
        ─ WS  /hub      (lobby) ──┤            │
        ─ static assets ──────────┘            ▼
                                   Lobby hub DO ◀── rooms publish here
                                   (directory + presence + world chat)
```

| file | role |
|---|---|
| `engine.mjs` | deterministic rules: moves, scoring, draw/challenge, sapaw, AI, redacted views |
| `room-core.mjs` | seats, join/leave, ready-up, lobby lifecycle, AI stepping, per-player views |
| `room-do.mjs` | the Room Durable Object — game WebSockets, storage, turn timers |
| `lobby-do.mjs` | the global hub — room directory **+** presence, unique names, world chat (WS) |
| `worker.mjs` | routes API, game WebSockets, and the `/hub` lobby WebSocket; serves the client |
| `public/index.html` | the whole game client (lobby + table) in one file |
| `wrangler.toml` | deploy config (DO bindings, static assets, migrations) |
| `*.test.mjs` | Node test suites |

---

## Current progress (done)

### The game
- **Real-time multiplayer** — the server owns the cards, so the client can't cheat.
- **Full draw / challenge rules** — call a draw only before drawing, with an
  exposed meld, and not right after a sapaw by or onto you. Opponents with a meld
  then **Challenge or Fold** in a popup; opponents without a meld are auto-burned.
  The caller's hand stays hidden until everyone decides; only the caller and
  challengers reveal. Lowest count wins; ties go to the challenger (last one, in a
  three-way tie).
- **Survival sapaw** — you can lay off onto any meld (yours or an opponent's) even
  without your own meld, to trim your hand and block the opponent's draw call. Bots
  do this too when they're under threat.
- **Sapaw by tap or drag** — arm a card and tap a glowing meld, or drag a card
  (from your hand or a group) straight onto a meld. Drag a card onto the discard
  to end your turn.
- **Round-over → Ready / Leave** — every human readies up for the next round (AI
  auto-readies); it deals when everyone's ready. Anyone can leave to the lobby; the
  rest see a red "player left" notice, and the freed seat re-lists in the lobby.
- **Turn timers** with a constant blinking AFK warning; going idle auto-discards
  your lowest card.
- **Two card looks** — a clean CSS deck by default, plus an optional SVG sprite
  deck via a **Card skin** toggle (your choice is remembered).
- **Animations** — cards fly from the draw pile to a hand, from a hand to the
  discard, and onto melds — for you *and* your opponents.
- **Mobile** — the log is hidden, chat becomes a popup with a new-message dot, a
  floating turn timer blinks red on your turn, and your hand fans to fit the screen.

### The lobby (real-time hub)
- **Full-page lobby** — Open Tables, Online Players, and World Chat side by side.
- **Presence** — everyone online is listed with a green dot and a **LOBBY** or
  **PLAYING** status.
- **Unique names** — case-insensitive; a name in use by someone online is rejected.
  Names allow letters, numbers, and at most one space.
- **World chat** — global chat that keeps the last 50 messages so newcomers see
  recent history.
- **@mentions** — type `@name`, or click a player to insert it; a bell chimes when
  you're mentioned in the lobby (silent while you're in a game).
- **How to play** lives in the lobby (removed from the in-game screen).

### The polish layer (client-only, no rules changed)
- **New visual identity** — night-market palette (tungsten gold on deep felt), narra-wood rail, capiz-cream cards, Baloo 2 + Nunito type, and a lobby hero with a fanned-cards logo.
- **Sound & haptics** — tiny synthesized WebAudio cues (draw, discard, meld, your-turn chime, win/lose sting) plus phone vibration; one-tap 🔊 toggle in the lobby and in-game header, remembered per device.
- **Your record** — a localStorage stats strip in the lobby: rounds, wins + win %, Tongits count, current/best win streak, and a 🔥 day-streak. No accounts needed; it all lives on the device.
- **Sort your hand** — ⇅ button toggles suit/rank ordering of ungrouped cards (client-side only).
- **Tabbed mobile lobby** — Tables / Players / World chat tabs on small screens instead of a long scroll.
- **Installable** — web manifest + generated icons, theme color, and safe-area insets, so “Add to Home Screen” gives a proper app feel.

**Economy off** — no coins, pots, ranks, or accounts. Everything is casual.

**Tests:** `engine.test.mjs` ~6,000 assertions · `room-core.test.mjs` 42 cases ·
`lobby-do.test.mjs` 19 cases. Run each with `node <file>`.

---

## Roadmap — what's next

- **Reconnect grace** — a short window so a dropped connection doesn't instantly
  drop you from a table (today, disconnect = leave).
- **Quick play** — a one-tap "join any open table."
- **AI-rescue rooms** — surface a 2-humans-plus-a-bot table with an open seat so a
  third human can swap in for the bot.
- **Lobby polish** — mention matching that respects word boundaries, a bell toggle,
  and removing the old (now-unused) center-modal lobby code.
- **Mobile polish** — continued tuning on small screens.

Deliberately **deferred** (to stay free and casual): coins/economy, ranks and
leaderboards, registration/account recovery, and social login.

---

## Deploy notes

The client is static assets; the server is the Worker plus two Durable Object
classes (`Room`, `Lobby`), both SQLite-backed and free-plan eligible. `wrangler.toml`
already contains their migrations — adding WebSockets to the existing `Lobby`
class needs no new migration. After updating files, redeploy and do a quick
**two-browser** check of the lobby (presence, world chat, unique names, the bell)
and a two-device check of a game (challenge/fold, ready-up, animations), since
live WebSocket behavior only proves out with more than one player connected.

---

*Built on Cloudflare Workers + Durable Objects. A casual project — feedback welcome.*
