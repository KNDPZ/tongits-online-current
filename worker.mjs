// ============================================================================
// worker.mjs — front door.
//   /api/create | /api/join | /api/start | /api/next | /api/state  -> Room DO
//   /ws?room=&token=  (WebSocket upgrade)                          -> Room DO
//   everything else  -> static client assets (the game UI)
//
// Stage-3 (lobby/matchmaking directory + quick-queue) will add /api/quickplay
// backed by a single Lobby DO; the per-room plumbing here already works.
// ============================================================================
export { Room } from "./room-do.mjs";
export { Lobby } from "./lobby-do.mjs";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // WebSocket upgrade -> room DO
    if (path === "/ws") {
      const roomId = up(url.searchParams.get("room"));
      if (!roomId) return new Response("missing room", { status: 400 });
      return roomStub(env, roomId).fetch(rewrite(request, url, "/ws"));
    }

    // Global hub WebSocket (presence + world chat) -> Lobby DO
    if (path === "/hub") {
      if (!env.LOBBY) return new Response("no hub", { status: 503 });
      return env.LOBBY.get(env.LOBBY.idFromName("global")).fetch(request);
    }

    // Lobby/room API
    if (path.startsWith("/api/")) {
      const action = path.slice("/api/".length);
      if (action === "create") {
        const body = await request.json().catch(() => ({}));
        const roomId = body.roomId ? up(body.roomId) : genRoomCode();
        const req = jsonRequest(url, "/create", { ...body, roomId });
        const res = await roomStub(env, roomId).fetch(req);
        return cors(res);
      }
      if (["join", "start", "next"].includes(action)) {
        const body = await request.json().catch(() => ({}));
        const roomId = up(body.roomId);
        if (!roomId) return cors(json({ error: "missing roomId" }, 400));
        return cors(await roomStub(env, roomId).fetch(jsonRequest(url, "/" + action, body)));
      }
      if (action === "state") {
        const roomId = up(url.searchParams.get("room"));
        if (!roomId) return cors(json({ error: "missing room" }, 400));
        return cors(await roomStub(env, roomId).fetch(rewrite(request, url, "/state")));
      }
      if (action === "rooms") {
        if (!env.LOBBY) return cors(json({ rooms: [] }));
        const id = env.LOBBY.idFromName("global");
        const u = new URL(url); u.pathname = "/list";
        return cors(await env.LOBBY.get(id).fetch(new Request(u.toString())));
      }
      return cors(json({ error: "unknown api" }, 404));
    }

    // static client (Workers Static Assets binding)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Tong-its API. Deploy the client to /public.", { status: 200 });
  },
};

function roomStub(env, roomId) {
  const id = env.ROOMS.idFromName(roomId);
  return env.ROOMS.get(id);
}
function up(s) { return s ? String(s).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : ""; }
function genRoomCode() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return [...a].map((b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join("");
}
function rewrite(request, url, pathname) {
  const u = new URL(url); u.pathname = pathname;
  return new Request(u.toString(), request);
}
function jsonRequest(url, pathname, body) {
  const u = new URL(url); u.pathname = pathname;
  return new Request(u.toString(), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h, webSocket: res.webSocket });
}
