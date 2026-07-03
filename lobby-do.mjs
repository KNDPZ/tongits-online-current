// ============================================================================
// lobby-do.mjs — a single global Durable Object that is BOTH:
//   (1) the public room directory (HTTP publish/unpublish/list), and
//   (2) a real-time hub over WebSockets: presence (who's online + status),
//       unique usernames, and world chat (last 50 messages kept).
// Uses WebSocket Hibernation; per-socket identity lives in the attachment.
// ============================================================================

const CHAT_MAX = 50;
const ROOM_STALE_MS = 120000;   // rooms republish every 45s; 2 missed beats -> pruned
export const CHAT_TTL_MS = 15 * 60 * 1000; // world-chat messages vanish after 15 minutes

export function normName(n) { return String(n || "").trim().toLowerCase(); }

// pure: drop chat lines older than the TTL
export function pruneChat(hist, now = Date.now()) {
  return (hist || []).filter((l) => l && typeof l.at === "number" && now - l.at < CHAT_TTL_MS);
}

// pure: prune stale rooms + shape the public list
export function shapeRooms(rooms, now = Date.now()) {
  const live = {};
  for (const k in rooms) if (now - rooms[k].at <= ROOM_STALE_MS) live[k] = rooms[k];
  return {
    live,
    list: Object.values(live)
      .filter((r) => r.open > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, 50)
      .map(({ at, ...m }) => m),
  };
}

// pure: dedupe presence by token (a user with two tabs shows once; "playing" wins)
export function dedupePresence(entries) {
  const byTok = new Map();
  for (const e of entries) {
    if (!e) continue;
    const prev = byTok.get(e.token);
    if (!prev || (e.status === "playing" && prev.status !== "playing")) byTok.set(e.token, e);
  }
  return [...byTok.values()]
    .map((e) => ({ name: e.name, status: e.status }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// pure: is `norm` already held by a different token among the given attachments?
export function nameTakenBy(attachments, norm, token) {
  return attachments.some((a) => a && a.norm === norm && a.token !== token);
}

// pure: sanitize the room-context fields a client may report with hello/status.
// roomId/open/cap/priv let the hub answer join requests and build invites.
export function roomCtx(d) {
  return {
    roomId: typeof d.roomId === "string" ? d.roomId.slice(0, 12) : "",
    open: Math.max(0, Math.min(2, d.open | 0)),
    cap: d.cap === 2 ? 2 : 3,
    priv: !!d.priv,
  };
}

export function pushChat(hist, line) {
  const h = hist.concat([line]);
  return h.length > CHAT_MAX ? h.slice(-CHAT_MAX) : h;
}

export class Lobby {
  constructor(state, env) { this.state = state; this.rooms = null; }
  async load() { if (!this.rooms) this.rooms = (await this.state.storage.get("rooms")) || {}; return this.rooms; }
  async saveRooms() { await this.state.storage.put("rooms", this.rooms); }
  async getChat() { return (await this.state.storage.get("chat")) || []; }

  sockets() { return this.state.getWebSockets(); }
  attachments() { return this.sockets().map((w) => { try { return w.deserializeAttachment(); } catch { return null; } }); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  broadcast(obj) { const s = JSON.stringify(obj); for (const w of this.sockets()) { try { w.send(s); } catch {} } }
  roomList() { const { live, list } = shapeRooms(this.rooms || {}); this.rooms = live; return list; }
  broadcastPresence(exclude) {
    const entries = this.sockets().filter((w) => w !== exclude).map((w) => { try { return w.deserializeAttachment(); } catch { return null; } });
    this.broadcast({ t: "presence", users: dedupePresence(entries) });
  }
  broadcastRooms() { this.broadcast({ t: "rooms", rooms: this.roomList() }); }
  // first socket whose (normalized) name matches
  findByName(norm) {
    for (const w of this.sockets()) {
      let a; try { a = w.deserializeAttachment(); } catch { continue; }
      if (a && a.norm === norm) return { ws: w, att: a };
    }
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ---- WebSocket hub ----
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // ---- HTTP room directory ----
    const action = url.pathname.split("/").filter(Boolean).pop();
    await this.load();
    if (action === "publish") {
      const b = await request.json().catch(() => ({}));
      if (b && b.meta && b.meta.roomId) { this.rooms[b.meta.roomId] = { ...b.meta, at: Date.now() }; await this.saveRooms(); this.broadcastRooms(); }
      return json({ ok: true });
    }
    if (action === "unpublish") {
      const b = await request.json().catch(() => ({}));
      if (b && b.roomId && this.rooms[b.roomId]) { delete this.rooms[b.roomId]; await this.saveRooms(); this.broadcastRooms(); }
      return json({ ok: true });
    }
    if (action === "list") { const list = this.roomList(); await this.saveRooms(); return json({ rooms: list }); }
    return json({ error: "unknown" }, 404);
  }

  async webSocketMessage(ws, raw) {
    let d; try { d = JSON.parse(raw); } catch { return; }
    await this.load();
    await this.handleMessage(ws, d);
  }

  // core message handler (kept separate so it's unit-testable)
  async handleMessage(ws, d) {
    if (d.t === "hello") {
      const name = String(d.name || "").trim().slice(0, 18);
      const token = String(d.token || "");
      const norm = normName(name);
      if (!name) { this.send(ws, { t: "nameTaken" }); return; }
      const others = this.sockets().filter((w) => w !== ws).map((w) => { try { return w.deserializeAttachment(); } catch { return null; } });
      if (nameTakenBy(others, norm, token)) { this.send(ws, { t: "nameTaken" }); return; }
      const status = d.status === "playing" ? "playing" : "lobby";
      ws.serializeAttachment({ token, name, norm, status, ...roomCtx(d) });
      this.send(ws, { t: "welcome", name });
      this.send(ws, { t: "chatHistory", lines: pruneChat(await this.getChat()) });
      this.send(ws, { t: "rooms", rooms: this.roomList() });
      this.broadcastPresence();
      return;
    }
    const self = (() => { try { return ws.deserializeAttachment(); } catch { return null; } })();
    if (!self) return; // must say hello first
    if (d.t === "status") {
      self.status = d.status === "playing" ? "playing" : "lobby";
      Object.assign(self, roomCtx(d));            // room the player is in (if any)
      ws.serializeAttachment(self);
      this.broadcastPresence();
      return;
    }
    if (d.t === "chat") {
      const text = String(d.text || "").trim().slice(0, 240);
      if (!text) return;
      const prev = pruneChat(await this.getChat());
      // replying to a message? embed a denormalized quote so history stays simple
      let reply;
      if (d.replyTo) {
        const src = prev.find((l) => l.id === d.replyTo);
        if (src) reply = { name: src.name, text: String(src.text || "").slice(0, 90) };
      }
      const line = { id: crypto.randomUUID().slice(0, 8), name: self.name, text, at: Date.now(), ...(reply ? { reply } : {}) };
      const hist = pushChat(prev, line);
      await this.state.storage.put("chat", hist);
      this.broadcast({ t: "chat", line });
      return;
    }

    // ---- join request: lobby player -> player who is inside a room -------------
    // sender asked to join the room `d.to` is sitting in; hub validates a seat
    // is open (room directory first, the player's self-report as fallback).
    if (d.t === "joinreq") {
      const norm = normName(d.to);
      if (!norm || norm === self.norm) { this.send(ws, { t: "sys", style: "err", text: "You can't send a join request to yourself." }); return; }
      const tgt = this.findByName(norm);
      if (!tgt) { this.send(ws, { t: "sys", style: "err", text: `@${String(d.to).slice(0, 18)} isn't online right now.` }); return; }
      if (!tgt.att.roomId) { this.send(ws, { t: "sys", style: "err", text: `@${tgt.att.name} isn't in a room right now.` }); return; }
      const reg = this.rooms[tgt.att.roomId];
      const open = reg ? (reg.open | 0) : (tgt.att.open | 0);
      if (open <= 0) { this.send(ws, { t: "sys", style: "err", text: "No available seat in that room — it's already full." }); return; }
      this.send(tgt.ws, { t: "joinreq", from: self.name });
      this.send(ws, { t: "sys", style: "info", text: `Join request sent to @${tgt.att.name} — waiting for them to accept…` });
      return;
    }

    // ---- join response: in-room player accepts/declines a request --------------
    if (d.t === "joinres") {
      if (!self.roomId) return;                       // must be in a room to answer
      const tgt = this.findByName(normName(d.to));
      if (!tgt) return;
      if (d.ok) this.send(tgt.ws, { t: "joinres", ok: true, from: self.name, roomId: self.roomId, invite: String(d.invite || "").slice(0, 32) });
      else this.send(tgt.ws, { t: "joinres", ok: false, from: self.name });
      return;
    }

    // ---- invite: in-room player -> lobby player ---------------------------------
    if (d.t === "invite") {
      if (!self.roomId) { this.send(ws, { t: "sys", style: "err", text: "You're not in a room — nothing to invite to." }); return; }
      const tgt = this.findByName(normName(d.to));
      if (!tgt) { this.send(ws, { t: "sys", style: "err", text: `@${String(d.to).slice(0, 18)} isn't online right now.` }); return; }
      this.send(tgt.ws, { t: "invite", from: self.name, roomId: self.roomId, cap: self.cap, priv: self.priv, invite: String(d.invite || "").slice(0, 32) });
      this.send(ws, { t: "sys", style: "info", text: `Invite sent to @${tgt.att.name}.` });
      return;
    }
    if (d.t === "ping") { this.send(ws, { t: "pong" }); return; }
  }

  async webSocketClose(ws) { try { ws.close(); } catch {} this.broadcastPresence(ws); }
  async webSocketError(ws) { this.broadcastPresence(ws); }
}

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
