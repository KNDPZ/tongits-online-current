# Tong-its Online

Free, unranked, **online multiplayer Tong-its** (the Filipino three-player rummy),
built to run entirely on Cloudflare's **free tier**. Server-authoritative, no
accounts, no money, no ads — just open a room and play.

**Live:** https://tongits.playy.online &nbsp;·&nbsp; mirror: https://vs.nullsec.online

> Status: playable. Online lobby + full round rules are in. The newest update
> reworks the **draw/challenge** mechanic to match real Tong-its.

---

## What it is

Tong-its is a 3-player rummy where you race to clear your hand into melds (sets
and runs), "sapaw" (lay off) onto exposed melds, and either go out completely
(**Tongits**) or **call a draw** and win the showdown on the lowest points. This
project is a faithful online version of a single-player game, rebuilt so people
can play each other in real time from a browser or phone.

---

## How it's built

Everything fits on Cloudflare's free plan: static assets for the client, one
Worker as the front door, one **SQLite-backed Durable Object per room** (with
WebSocket Hibernation, so idle rooms cost nothing), and a single global Lobby
Durable Object that holds the public room list.

```
browser ──HTTP /api/* ───────────┐
        ──WS  /ws?room=&token= ──┼─▶ Worker ──▶ Room DO  (one per room: state, WS, timers)
        ──static assets ─────────┘    │                     │
                                      └──▶ Lobby DO  ◀───────┘ (publishes the public room list)
                                                  │
                            room-core.mjs (seats, lifecycle) ─▶ engine.mjs (pure rules)
```

| file | role |
|---|---|
| `engine.mjs` | deterministic rules: moves, scoring, draw/challenge, AI, redacted views |
| `room-core.mjs` | seats, join/leave, ready/lobby, AI stepping, per-player views |
| `room-do.mjs` | the Room Durable Object — WebSockets, storage, turn timers/alarms |
| `lobby-do.mjs` | the global Lobby Durable Object — public room directory |
| `worker.mjs` | routes API + WebSocket traffic and serves the client |
| `public/index.html` | the game client (the whole UI in one file) |
| `wrangler.toml` | deploy config (DO bindings + static assets + migrations) |
| `*.test.mjs` | Node test suites |

---

## Current progress (done)

- **Real-time multiplayer** — server-authoritative rooms over WebSockets; the
  server owns the cards, so the client can't cheat.
- **Public lobby** — a home-screen list of open rooms you can join with one tap
  (labelled 1v1 for 2 seats, 1v2 for 3 seats), backed by a global Lobby DO.
- **Ready / room setup** — a **Ready** button publishes your room to the lobby.
  1v1 auto-starts when a second human joins; 3-player rooms pick between
  *"start with an open seat"* and *"wait for the table to fill."*
- **Fill with AI** — start instantly against bots in a private (unlisted) room.
- **Room lifecycle** — leaving frees your seat for anyone; leaving mid-round
  voids that round as a **dud** ("doesn't count"); when only one human is left
  they're returned to the lobby; bot rooms backfill empty seats with AI.
- **Spectators** — join a game in progress and watch (public info only), then get
  dealt in on the next round.
- **Turn timers** — 20s for humans, faster for AI; if you go AFK the server
  auto-plays a safe move so the table never hangs.
- **Faithful UI** — the original look ported over: copper-rail felt table, the
  same card design, drag-to-group / drag-to-reorder / drag-to-discard, the gold
  "you can take this" glow on the discard pile, sapaw arming, and fly animations.
- **Economy off** — no coins, pots, ranks, or accounts. Everything is casual.

**Tests:** `engine.test.mjs` — 5,998 assertions; `room-core.test.mjs` — 37 cases.
Run with `node engine.test.mjs` and `node room-core.test.mjs`.

---

## What's new in this update — the draw / challenge rework

The "call a draw" mechanic now follows real Tong-its instead of instantly ending
the round.

- **Proper eligibility.** You can only call a draw at the **start of your turn,
  before drawing**, and only if you have at least one exposed meld. You're blocked
  for one turn if you laid off (sapaw) on your previous turn, **or** if anyone laid
  off onto one of your melds since your previous turn — you have to wait for your
  next turn. (This fixes the bug where a bot could meld and instantly win.)
- **Challenge or fold.** When you call, every opponent **with a meld** chooses to
  **Challenge** or **Fold**. Opponents **without** a meld are automatically folded
  ("burned") and don't reveal anything.
- **Hidden until everyone decides.** The caller's hand is **only revealed after
  all opponents have answered** — challengers reveal too, while folded and burned
  players keep their cards hidden. Lowest points wins; ties go to the challenger,
  and a three-way tie goes to whoever challenged last.
- **Smarter AI.** Bots now answer a called draw (challenge with a low hand, fold
  otherwise) and call far less recklessly — only with a genuinely strong hand.
- **Showdown screen.** The round-over modal shows who called, who challenged, who
  folded, who was burned, and the winner — and it no longer leaks the hands of
  players who folded or burned.

---

## Roadmap — things to look for next

Near-term polish and features being considered:

- **Reconnect grace** — a short window so a dropped Wi-Fi connection doesn't
  instantly kick you from the table (today, disconnect = leave).
- **Quick play** — a one-tap "join any open table" button so you don't have to
  scan the lobby.
- **AI-rescue rooms** — let a 2-humans-plus-a-bot room with an open seat show up
  in the public list, so a third human can swap in for the bot.
- **Chat polish** — friendlier table chat, and possibly a lightweight global chat
  so players can find each other.
- **Mobile layout pass** — tuning the table and controls for small screens.

Deliberately **deferred** (not planned for now): coins/economy, ranks and
leaderboards, registration/account recovery, and social login. The game is meant
to stay free and casual.

---

## Deploy notes

The client is static assets; the server is the Worker plus the two Durable
Objects. `wrangler.toml` includes the migration that creates the Lobby DO
alongside the Room DO. After updating files, redeploy and play a quick all-AI
round to confirm the new draw/challenge flow end-to-end (live WebSocket behavior
can only be verified after deploy).

---

*Built on Cloudflare Workers + Durable Objects. Casual project — feedback welcome.*
