# Tong-its multiplayer — Cloudflare build

Server-authoritative online Tong-its, designed to run on Cloudflare's **free
tier**: Workers Static Assets for the client, a Worker front door, and one
**SQLite-backed Durable Object per room** (free-plan eligible, with WebSocket
Hibernation so idle rooms cost nothing).

```
browser --HTTP /api/* ----------+
        --WS  /ws?room=&token=  -+-> Worker (worker.mjs) --> Room DO (room-do.mjs)
        --static assets ---------+                                | owns one room
                                                                  v
                                            room-core.mjs (pure) -> engine.mjs (rules)
```

## Files
| file | runs in | role |
|---|---|---|
| engine.mjs | DO + Node | deterministic rules, applyMove, aiMove, redaction |
| room-core.mjs | DO + Node | seats, join/access control, AI stepping, per-seat views |
| room-do.mjs | Cloudflare | Durable Object: WebSockets (hibernation), storage, alarms |
| worker.mjs | Cloudflare | routes API + WS to the right room; serves the client |
| wrangler.toml | - | deploy config (SQLite DO + static assets) |
| *.test.mjs | Node | test suites |

## Build stages
1. Engine - DONE & tested (`node engine.test.mjs`, 5194 assertions).
2. Room layer - DONE & tested (`node room-core.test.mjs`, 57 assertions) plus the
   Durable Object / Worker adapter (parse-checked; live WS verified on deploy).
3. Lobby / matchmaking - TODO: quick-queue + public room directory (a single
   Lobby DO) and invite-link UI. Per-room create/join/password/invite work now.
4. UI rewire - TODO: the existing game becomes a renderer over the WS protocol;
   single-player vs AI keeps running the engine locally.

## HTTP API (via the Worker)
- POST /api/create  { name, token, capacity?, private?, password? }
  -> { roomId, seat:0, invite }   (roomId auto-generated if omitted)
- POST /api/join    { roomId, token, name, password?, invite? }
  -> { seat, reconnected } or { error }
- POST /api/start   { roomId, token }   (host only - fills empty seats with AI, deals)
- POST /api/next    { roomId, token }   (host only - deal next round)
- GET  /api/state?room=&token=          -> redacted view (debug/polling)
- GET  /ws?room=&token=   (Upgrade: websocket)

## WebSocket protocol
Client -> server: {t:"move", move}, {t:"start"}, {t:"next"}, {t:"chat", text}, {t:"sync"}
where move is one of the engine moves:
{type:"draw"}, {type:"drawDiscard", cards:[id...]}, {type:"meld", cards:[id...]},
{type:"sapaw", card, owner, meldIdx}, {type:"discard", card}, {type:"call"}.

Server -> client:
- {t:"state", view}  - the redacted view for THAT connection (lobby or game).
- {t:"error", error} - last move rejected (with reason); client should resync.
- {t:"chat", line}   - {name, text, at}.

view is viewForToken: your own hand + counts of others, the public discard and
melds, whose turn it is, money/records/seats, and - only once the round is over -
every hand revealed for verification.

## Identity
A player is a { name, token }. The token (random UUID, stored client-side) is the
real identity used to claim/reclaim a seat and reconnect; the name is a display
label. No accounts needed for casual play.

## Run the tests (Node)
```
node engine.test.mjs
node room-core.test.mjs
```

## Deploy (your Cloudflare account)
```
npm i -g wrangler            # or: npx wrangler ...
# put the game client at ./public/index.html
wrangler deploy             # publishes worker + Room DO; assets served from /public
```
SQLite Durable Objects + Hibernation keep a turn-based room effectively free.

## Notes / decisions to revisit
- Capacity 2 or 3 (default 3). A true 1v1 variant still needs a deal/rules
  decision; the code already accepts capacity:2.
- Disconnect: a vanished player gets a 30s grace, then their seat is handed to
  AI so others can finish. Human bust: the seat is converted to AI for table
  continuity (placeholder - we may prefer a rebuy/leave flow later).
- Alarms are a single slot per DO; AI pacing (1.2s) and the disconnect grace
  share it. Fine for a turn-based game; noted for awareness.
- Live WebSocket round-trips and matchmaking can only be verified on a real
  `wrangler deploy` with a second device - the logic is tested in Node.
