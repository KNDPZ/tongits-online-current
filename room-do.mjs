// ============================================================================
// room-do.mjs (v2) — Room Durable Object. I/O only; logic lives in room-core.
//   - WebSocket Hibernation; storage persistence
//   - turn clock (alarm) + AFK auto-play
//   - ready/auto-start, leave/open-seat/dud/kick, spectators
//   - publishes its public listing to the Lobby Directory
// ============================================================================
import * as RC from "./room-core.mjs";

const LIST_PING_MS = 45000;    // republish a listed, non-playing room this often
const GHOST_MS = 180000;       // no message from anyone for this long -> close the room

export class Room {
  constructor(state, env) {
    this.state = state; this.env = env; this.room = null;
    this._wokeAt = Date.now(); this._lastMsgAt = 0;   // liveness clock for the ghost reaper
    this.lobby = env.LOBBY ? env.LOBBY.get(env.LOBBY.idFromName("global")) : null;
    this.sockets = new Map();
    for (const ws of this.state.getWebSockets()) {
      const a = safeAttach(ws); if (a && a.token) this.sockets.set(a.token, ws);
    }
  }
  async load() { if (!this.room) this.room = (await this.state.storage.get("room")) || null; return this.room; }
  async save() { if (this.room) await this.state.storage.put("room", this.room); }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean).pop();
    if (action === "ws") return this.handleWs(request, url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    await this.load();

    switch (action) {
      case "create": {
        if (this.room) return json({ error: "room already exists" }, 409);
        const passwordHash = body.password ? await sha256hex(body.password) : null;
        const inviteToken = randomId(14);
        this.room = RC.createRoom({
          roomId: body.roomId, hostToken: body.token, hostName: body.name || "Host",
          capacity: clampCap(body.capacity), isPrivate: !!body.private, passwordHash, inviteToken,
          roomName: body.roomName,
        });
        await this.save();
        return json({ ok: true, roomId: this.room.roomId, seat: 0, invite: inviteToken });
      }
      case "join": {
        this._lastMsgAt = Date.now();
        if (!this.room || this.room.status === "closed") return json({ error: "no such room" }, 404);
        const pph = body.password ? await sha256hex(body.password) : null;
        const r = RC.joinRoom(this.room, { token: body.token, name: body.name, providedPasswordHash: pph, invite: body.invite });
        if (!r.ok) return json({ error: r.error }, 403);
        if (RC.shouldAutoStart(this.room)) { RC.dealRound(this.room, undefined, cryptoSeed()); await this.armTurn(); }
        await this.save(); this.broadcast(); await this.publishLobby();
        return json({ ok: true, seat: r.seat, reconnected: !!r.reconnected, spectator: !!r.spectator, capacity: this.room.capacity });
      }
      case "state":
        if (!this.room) return json({ error: "no such room" }, 404);
        return json(RC.viewForToken(this.room, url.searchParams.get("token")));
      default:
        return json({ error: "unknown action" }, 404);
    }
  }

  async handleWs(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const token = url.searchParams.get("token");
    await this.load();
    if (!this.room || RC.seatIndexOf(this.room, token) < 0) return new Response("not seated", { status: 403 });
    const pair = new WebSocketPair(); const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ token });
    this.sockets.set(token, server);
    this._lastMsgAt = Date.now();
    RC.setConnected(this.room, token, true);
    await this.save(); this.sendTo(token); this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    this._lastMsgAt = Date.now();
    await this.load(); if (!this.room) return;
    const a = safeAttach(ws); const token = a && a.token;
    let d; try { d = JSON.parse(raw); } catch { return; }
    const host = token === this.room.hostToken;

    if (d.t === "move") {
      const res = RC.humanMove(this.room, token, d.move);
      if (!res.ok) { await this.save(); wsSend(ws, { t: "error", error: res.error }); this.sendTo(token); }
      else { await this.resolvePhase(); await this.armTurn(); await this.save(); this.broadcast(); }
    } else if (d.t === "start" && host) {
      const r = RC.startMatch(this.room, { seed: cryptoSeed() });
      if (r.ok) { await this.armTurn(); await this.save(); this.broadcast(); await this.publishLobby(); }
      else wsSend(ws, { t: "error", error: r.error });
    } else if (d.t === "ready" && host) {
      const r = RC.setReady(this.room, token, d.mode);
      if (!r.ok) { wsSend(ws, { t: "error", error: r.error }); return; }
      if (RC.shouldAutoStart(this.room)) { RC.dealRound(this.room, undefined, cryptoSeed()); await this.armTurn(); }
      await this.save(); this.broadcast(); await this.publishLobby();
    } else if (d.t === "next" && host) {
      const r = RC.nextRound(this.room, { seed: cryptoSeed() });
      if (r.ok) { await this.armTurn(); await this.save(); this.broadcast(); await this.publishLobby(); }
      else wsSend(ws, { t: "error", error: r.error });
    } else if (d.t === "readyNext") {
      const r = RC.readyNextUp(this.room, token);
      if (r.ok && r.allReady) { const nr = RC.nextRound(this.room, { seed: cryptoSeed() }); if (nr.ok) await this.armTurn(); }
      await this.save(); this.broadcast(); await this.publishLobby();
      if (!r.ok) wsSend(ws, { t: "error", error: r.error });
    } else if (d.t === "leave") {
      await this.handleLeave(token);
    } else if (d.t === "chat") {
      const line = RC.addChat(this.room, token, d.text || ""); await this.save();
      this.broadcastRaw({ t: "chat", line });
    } else if (d.t === "sync") {
      this.sendTo(token);
    } else if (d.t === "ping") {
      wsSend(ws, { t: "pong" });   // liveness only (updates _lastMsgAt above)
    }
  }

  async webSocketClose(ws) { await this.handleGone(ws); }
  async webSocketError(ws) { await this.handleGone(ws); }
  async handleGone(ws) {
    await this.load(); if (!this.room) return;
    const a = safeAttach(ws); const token = a && a.token; if (!token) return;
    // disconnect == leave (per current product decision)
    await this.handleLeave(token);
  }

  async handleLeave(token) {
    if (!this.room || RC.seatIndexOf(this.room, token) < 0) { this.sockets.delete(token); return; }
    const res = RC.leaveRoom(this.room, token, { rnd: Math.random });
    const lws = this.sockets.get(token);
    if (lws) wsSend(lws, { t: "left" });
    this.sockets.delete(token);
    if (res.closed) {
      for (const k of res.kick) { const w = this.sockets.get(k); if (w) wsSend(w, { t: "kicked", reason: res.dudReason || "Not enough players — back to the lobby." }); }
      await this.save(); this.broadcast(); await this.publishLobby();   // meta null -> unpublished
      return;
    }
    await this.armTurn(); await this.save(); this.broadcast(); await this.publishLobby();
  }

  async alarm() {
    await this.load(); if (!this.room) return;
    if (this.room.status === "over" && this.room._dealNextAt) {
      this.room._dealNextAt = false;
      const r = RC.nextRound(this.room, { seed: cryptoSeed() });
      if (r.ok) await this.armTurn();
      await this.save(); this.broadcast(); await this.publishLobby();
      return;
    }
    if (this.room.status !== "playing") {
      // Non-playing (waiting / between rounds) rooms:
      //  - if nobody has sent anything for GHOST_MS (silent disconnects never
      //    deliver a close frame), close the room and clear the listing;
      //  - otherwise refresh the public listing so the directory TTL never
      //    prunes a healthy room, and re-arm the keepalive.
      if (this.room.status !== "closed") {
        const lastAlive = Math.max(this._lastMsgAt || 0, this._wokeAt || 0);
        if (Date.now() - lastAlive > GHOST_MS) {
          this.room.status = "closed";
          for (const w of this.sockets.values()) wsSend(w, { t: "kicked", reason: "Room closed — connection lost." });
          await this.save(); await this.publishLobby();
          return;
        }
        await this.publishLobby();
        if (RC.lobbyMeta(this.room)) await this.state.storage.setAlarm(Date.now() + LIST_PING_MS);
      }
      return;
    }
    const now = Date.now();
    if (this.room.turnDeadline && now < this.room.turnDeadline - 250) { await this.state.storage.setAlarm(this.room.turnDeadline); return; }
    const m = this.room.match;
    if (RC.inChallenge(this.room)) {
      RC.autoFoldPending(this.room);                 // responders ran out of time -> fold
      await this.armTurn(); await this.save(); this.broadcast(); await this.publishLobby();
      return;
    }
    if (RC.currentIsAI(this.room)) {
      const start = m.round.currentIdx; let g = 0;
      while (this.room.status === "playing" && m.round.currentIdx === start && g++ < 40) if (!RC.stepAIOnce(this.room).stepped) break;
      await this.resolvePhase();                      // an AI may have called a draw
    } else {
      RC.autoPlay(this.room);
    }
    await this.armTurn(); await this.save(); this.broadcast();
  }

  async armTurn() {
    if (!this.room || this.room.status !== "playing") { if (this.room) this.room.turnDeadline = null; return; }
    this.room.turnDeadline = Date.now() + RC.turnMsFor(this.room);
    await this.state.storage.setAlarm(this.room.turnDeadline);
  }

  // During a called draw, answer all AI responders right away so only humans hold it up.
  async resolvePhase() {
    if (!this.room) return;
    let g = 0;
    while (RC.inChallenge(this.room) && g++ < 12) {
      if (!RC.stepAIOnce(this.room).stepped) break;
    }
  }

  async publishLobby() {
    if (!this.lobby || !this.room) return;
    const meta = RC.lobbyMeta(this.room);
    try {
      if (meta) await this.lobby.fetch("https://l/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meta }) });
      else await this.lobby.fetch("https://l/unpublish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: this.room.roomId }) });
    } catch (e) { /* lobby optional */ }
    // listed but not playing -> make sure the keepalive/reaper alarm is armed
    if (meta && this.room.status !== "playing") {
      const cur = await this.state.storage.getAlarm();
      if (cur == null) await this.state.storage.setAlarm(Date.now() + LIST_PING_MS);
    }
  }

  sendTo(token) { const ws = this.sockets.get(token); if (ws) wsSend(ws, { t: "state", view: RC.viewForToken(this.room, token) }); }
  broadcast() { for (const ws of this.state.getWebSockets()) { const a = safeAttach(ws); if (!a || !a.token) continue; wsSend(ws, { t: "state", view: RC.viewForToken(this.room, a.token) }); } }
  broadcastRaw(o) { for (const ws of this.state.getWebSockets()) wsSend(ws, o); }
}

function safeAttach(ws) { try { return ws.deserializeAttachment(); } catch { return null; } }
function wsSend(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }
function clampCap(c) { c = c | 0; return c === 2 ? 2 : 3; }
function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
function randomId(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join(""); }
function cryptoSeed() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] | 0; }
async function sha256hex(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
