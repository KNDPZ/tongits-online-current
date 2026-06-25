// ============================================================================
// room-do.mjs — the Room Durable Object (Cloudflare runtime adapter).
// All game logic lives in room-core/engine; this only does I/O:
//   - WebSocket Hibernation (idle rooms cost nothing)
//   - storage persistence of the room object
//   - Alarms for AI move pacing and disconnect -> AI takeover
// ============================================================================
import * as RC from "./room-core.mjs";

// Turn lengths come from room-core (AI 8s, human 20s). The Durable Object
// enforces them with a single alarm set to the current turn's deadline.

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    // rebuild token->socket map from any hibernated sockets
    this.sockets = new Map();
    for (const ws of this.state.getWebSockets()) {
      const att = safeAttach(ws);
      if (att && att.token) this.sockets.set(att.token, ws);
    }
  }

  async load() {
    if (!this.room) this.room = (await this.state.storage.get("room")) || null;
    return this.room;
  }
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
          capacity: clampCap(body.capacity), isPrivate: !!body.private,
          passwordHash, inviteToken, startMoney: 50, ante: 10,
        });
        await this.save();
        return json({ ok: true, roomId: this.room.roomId, seat: 0, invite: inviteToken });
      }
      case "join": {
        if (!this.room) return json({ error: "no such room" }, 404);
        const providedPasswordHash = body.password ? await sha256hex(body.password) : null;
        const r = RC.joinRoom(this.room, { token: body.token, name: body.name, providedPasswordHash, invite: body.invite });
        if (!r.ok) return json({ error: r.error }, 403);
        await this.save();
        this.broadcast();
        return json({ ok: true, seat: r.seat, reconnected: !!r.reconnected, capacity: this.room.capacity });
      }
      case "start": {
        if (!this.room) return json({ error: "no such room" }, 404);
        if (body.token !== this.room.hostToken) return json({ error: "only the host can start" }, 403);
        const res = RC.startMatch(this.room, { seed: cryptoSeed() });
        if (!res.ok) return json({ error: res.error }, 400);
        await this.armTurn();
        await this.save();
        this.broadcast();
        return json({ ok: true });
      }
      case "next": {
        if (!this.room) return json({ error: "no such room" }, 404);
        if (body.token !== this.room.hostToken) return json({ error: "only the host can deal" }, 403);
        const res = RC.nextRound(this.room);
        if (!res.ok) return json({ error: res.error }, 400);
        await this.armTurn();
        await this.save();
        this.broadcast();
        return json({ ok: true });
      }
      case "state": {
        if (!this.room) return json({ error: "no such room" }, 404);
        return json(RC.viewForToken(this.room, url.searchParams.get("token")));
      }
      default:
        return json({ error: "unknown action" }, 404);
    }
  }

  async handleWs(request, url) {
    if (request.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const token = url.searchParams.get("token");
    await this.load();
    if (!this.room || RC.seatIndexOf(this.room, token) < 0)
      return new Response("not seated in this room", { status: 403 });

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.state.acceptWebSocket(server);          // hibernation-aware
    server.serializeAttachment({ token });
    this.sockets.set(token, server);
    RC.setConnected(this.room, token, true);
    await this.save();
    this.sendTo(token);
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- hibernation socket handlers ----
  async webSocketMessage(ws, raw) {
    await this.load();
    if (!this.room) return;
    const att = safeAttach(ws); const token = att && att.token;
    let data; try { data = JSON.parse(raw); } catch { return; }

    if (data.t === "move") {
      const res = RC.humanMove(this.room, token, data.move);
      if (!res.ok) { await this.save(); wsSend(ws, { t: "error", error: res.error }); this.sendTo(token); }
      else { await this.armTurn(); await this.save(); this.broadcast(); }
    } else if (data.t === "start") {
      if (token === this.room.hostToken) {
        const res = RC.startMatch(this.room, { seed: cryptoSeed() });
        if (res.ok) { await this.armTurn(); await this.save(); this.broadcast(); }
        else wsSend(ws, { t: "error", error: res.error });
      }
    } else if (data.t === "next") {
      if (token === this.room.hostToken) {
        const res = RC.nextRound(this.room);
        if (res.ok) { await this.armTurn(); await this.save(); this.broadcast(); }
        else wsSend(ws, { t: "error", error: res.error });
      }
    } else if (data.t === "chat") {
      const line = RC.addChat(this.room, token, data.text || "");
      await this.save();
      this.broadcastRaw({ t: "chat", line });
    } else if (data.t === "sync") {
      this.sendTo(token);
    }
  }

  async webSocketClose(ws) { await this.onGone(ws); }
  async webSocketError(ws) { await this.onGone(ws); }

  async onGone(ws) {
    await this.load();
    if (!this.room) return;
    const att = safeAttach(ws); const token = att && att.token;
    if (!token) return;
    this.sockets.delete(token);
    RC.setConnected(this.room, token, false);
    await this.save();
    this.broadcast();
    // No special handling needed: if it's their turn, the turn clock will
    // auto-play the minimum legal move when it expires.
  }

  async alarm() {
    await this.load();
    if (!this.room || this.room.status !== "playing") return;
    const now = Date.now();
    // Defensive: if a newer move pushed the deadline out, re-arm and wait.
    if (this.room.turnDeadline && now < this.room.turnDeadline - 250) {
      await this.state.storage.setAlarm(this.room.turnDeadline);
      return;
    }
    const m = this.room.match;
    if (RC.currentIsAI(this.room)) {
      // AI "thinks" for the turn length, then plays its whole turn at once.
      const start = m.round.currentIdx;
      let guard = 0;
      while (this.room.status === "playing" && m.round.currentIdx === start && guard++ < 40) {
        if (!RC.stepAIOnce(this.room).stepped) break;
      }
    } else {
      // Human ran out of time -> auto-play the minimum legal move.
      RC.autoPlay(this.room);
    }
    await this.armTurn();
    await this.save();
    this.broadcast();
  }

  // Set the current turn's deadline and a single alarm to enforce it.
  async armTurn() {
    if (!this.room || this.room.status !== "playing") {
      this.room && (this.room.turnDeadline = null);
      await this.state.storage.deleteAlarm().catch(() => {});
      return;
    }
    this.room.turnDeadline = Date.now() + RC.turnMsFor(this.room);
    await this.state.storage.setAlarm(this.room.turnDeadline);
  }

  // ---- send helpers ----
  sendTo(token) {
    const ws = this.sockets.get(token);
    if (ws) wsSend(ws, { t: "state", view: RC.viewForToken(this.room, token) });
  }
  broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const att = safeAttach(ws); if (!att || !att.token) continue;
      wsSend(ws, { t: "state", view: RC.viewForToken(this.room, att.token) });
    }
  }
  broadcastRaw(obj) {
    for (const ws of this.state.getWebSockets()) wsSend(ws, obj);
  }
}

// ---- helpers ---------------------------------------------------------------
function safeAttach(ws) { try { return ws.deserializeAttachment(); } catch { return null; } }
function wsSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ } }
function clampCap(c) { c = c | 0; return c === 2 ? 2 : 3; }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
function randomId(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map((b) => "0123456789abcdefghijklmnopqrstuvwxyz"[b % 36]).join("");
}
function cryptoSeed() {
  const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] | 0;
}
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
