// ============================================================================
// lobby-do.mjs — a single global Durable Object holding the public room list.
// Rooms publish/unpublish their meta as they become ready, fill, or close.
// ============================================================================
export class Lobby {
  constructor(state, env) { this.state = state; this.rooms = null; }
  async load() { if (!this.rooms) this.rooms = (await this.state.storage.get("rooms")) || {}; return this.rooms; }
  async save() { await this.state.storage.put("rooms", this.rooms); }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split("/").filter(Boolean).pop();
    await this.load();

    if (action === "publish") {
      const b = await request.json().catch(() => ({}));
      if (b && b.meta && b.meta.roomId) { this.rooms[b.meta.roomId] = { ...b.meta, at: Date.now() }; await this.save(); }
      return json({ ok: true });
    }
    if (action === "unpublish") {
      const b = await request.json().catch(() => ({}));
      if (b && b.roomId && this.rooms[b.roomId]) { delete this.rooms[b.roomId]; await this.save(); }
      return json({ ok: true });
    }
    if (action === "list") {
      const now = Date.now();
      let changed = false;
      for (const k in this.rooms) if (now - this.rooms[k].at > 600000) { delete this.rooms[k]; changed = true; }
      if (changed) await this.save();
      const rooms = Object.values(this.rooms)
        .filter((r) => r.open > 0)
        .sort((a, b) => b.at - a.at)
        .slice(0, 50)
        .map(({ at, ...m }) => m);
      return json({ rooms });
    }
    return json({ error: "unknown" }, 404);
  }
}
function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
