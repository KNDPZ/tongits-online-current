// ============================================================================
// room-core.mjs — pure room logic (no Cloudflare runtime, no WebSockets).
// Operates on a plain `room` object so it's fully testable in Node.
// The Durable Object (room-do.mjs) is a thin adapter that calls into this.
// ============================================================================
import * as E from "./engine.mjs";

const AI_NAMES = [
  "Aling Nena", "Mang Tonio", "Kuya Boy", "Ate Vi", "Lolo Ben", "Tita Baby",
  "Pareng Jun", "Mareng Susan", "Inting", "Dado", "Tisoy", "Kapitan",
  "Aling Cora", "Mang Berto", "Bunso", "Idol",
];
export function pickAIName(used) {
  const avail = AI_NAMES.filter((n) => !used.includes(n));
  const pool = avail.length ? avail : AI_NAMES;
  // caller passes an index for determinism in tests; default random
  return pool;
}
function chooseAIName(used, rnd = Math.random) {
  const pool = pickAIName(used);
  return pool[Math.floor(rnd() * pool.length)];
}

function seat(token, name, isAI) {
  return { token, name, isAI: !!isAI, connected: false, bustedOut: false };
}

export function createRoom(opts) {
  const {
    roomId, hostToken, hostName, capacity = 3,
    isPrivate = false, passwordHash = null, inviteToken,
    startMoney = 50, ante = 10,
  } = opts;
  const seats = new Array(capacity).fill(null);
  seats[0] = seat(hostToken, hostName, false);
  return {
    roomId, hostToken, capacity, isPrivate, passwordHash, inviteToken,
    startMoney, ante,
    seats,
    match: null,
    status: "lobby", // lobby | playing | over | ended
    dealerSeat: 0,
    round: 0,
    chat: [],
  };
}

export function seatIndexOf(room, token) {
  return room.seats.findIndex((s) => s && s.token === token);
}

// Join (or reconnect). Returns { ok, seat, error, reconnected }.
// `providedPasswordHash` is the SHA-256 of the attempt (the DO hashes it);
// `invite` is a token from an invite link (bypasses password).
export function joinRoom(room, { token, name, providedPasswordHash = null, invite = null }) {
  const existing = seatIndexOf(room, token);
  if (existing >= 0) {
    room.seats[existing].connected = true;
    if (name) room.seats[existing].name = room.seats[existing].isAI ? room.seats[existing].name : name;
    return { ok: true, seat: existing, reconnected: true };
  }
  if (room.status !== "lobby") return { ok: false, error: "game already in progress" };

  const inviteOk = invite && room.inviteToken && invite === room.inviteToken;
  if (!inviteOk && room.isPrivate) {
    if (!providedPasswordHash || providedPasswordHash !== room.passwordHash)
      return { ok: false, error: "wrong or missing password" };
  }
  const free = room.seats.findIndex((s) => s === null);
  if (free < 0) return { ok: false, error: "room is full" };
  room.seats[free] = seat(token, name || "Player", false);
  room.seats[free].connected = true;
  return { ok: true, seat: free, reconnected: false };
}

export function setConnected(room, token, connected) {
  const i = seatIndexOf(room, token);
  if (i >= 0) room.seats[i].connected = connected;
  return i;
}

// Convert a seat to AI (used when a disconnected human is replaced after grace,
// or a busted human's seat continues so others can keep playing).
export function convertSeatToAI(room, seatIdx, aiName) {
  const s = room.seats[seatIdx];
  if (!s) return;
  s.isAI = true;
  s.name = aiName || s.name;
  if (room.match) {
    room.match.players[seatIdx].isAI = true;
    room.match.players[seatIdx].name = s.name;
  }
}

export function canStart(room) {
  if (room.status !== "lobby") return false;
  const humans = room.seats.filter((s) => s && !s.isAI).length;
  return humans >= 1;
}

// Host starts: fill empty seats with AI, build the engine match, deal round 1.
export function startMatch(room, { seed, rnd = Math.random, dealerSeat } = {}) {
  if (!canStart(room)) return { ok: false, error: "cannot start yet" };
  const used = room.seats.filter(Boolean).map((s) => s.name);
  for (let i = 0; i < room.capacity; i++) {
    if (!room.seats[i]) {
      const nm = chooseAIName(used, rnd);
      used.push(nm);
      room.seats[i] = seat("ai:" + i, nm, true);
    }
  }
  const players = room.seats.map((s) => ({ id: s.token, name: s.name, isAI: s.isAI }));
  room.match = E.createMatch({ players, startMoney: room.startMoney, ante: room.ante, seed });
  const dealer = Number.isInteger(dealerSeat) ? dealerSeat : Math.floor(rnd() * room.capacity);
  room.dealerSeat = dealer;
  E.startRound(room.match, dealer);
  room.status = "playing";
  room.round = 1;
  return { ok: true };
}

// Deal the next round after one ends. Handles antes/bust: busted AI seats are
// re-bought with a new name; a busted human's seat is converted to AI so the
// remaining players can keep going (policy placeholder — revisit for UX).
export function nextRound(room, { rnd = Math.random } = {}) {
  if (room.status !== "over") return { ok: false, error: "round not over" };
  const m = room.match;
  const used = room.seats.map((s) => s.name);
  for (let i = 0; i < room.capacity; i++) {
    const p = m.players[i];
    if (p.money < room.ante) {
      const nm = chooseAIName(used.filter((_, k) => k !== i), rnd);
      used[i] = nm;
      if (!room.seats[i].isAI) room.seats[i].bustedOut = true; // human busted
      E.replaceSeat(m, i, nm);
      convertSeatToAI(room, i, nm);
    }
  }
  // choose a dealer that can play (a winner if possible, else any seat)
  let dealer = m.round.result ? m.round.result.nextDealer : 0;
  if (m.players[dealer].money < room.ante) dealer = m.players.findIndex((p) => p.money >= room.ante);
  if (dealer < 0) { room.status = "ended"; return { ok: false, error: "no one can ante" }; }
  E.startRound(m, dealer);
  room.dealerSeat = dealer;
  room.status = "playing";
  room.round++;
  return { ok: true };
}

// A human (by token) submits a move. Returns engine {ok,error}.
export function humanMove(room, token, move) {
  if (room.status !== "playing" || !room.match) return { ok: false, error: "not playing" };
  const m = room.match;
  const idx = m.players.findIndex((p) => p.id === token);
  if (idx < 0) return { ok: false, error: "not in this match" };
  if (idx !== m.round.currentIdx) return { ok: false, error: "not your turn" };
  if (m.players[idx].isAI) return { ok: false, error: "seat is AI-controlled" };
  const res = E.applyMove(m, token, move);
  if (res.ok && m.round.over) room.status = "over";
  return res;
}

// Apply one AI move if it's an AI seat's turn. Returns {stepped, over, ...}.
export function stepAIOnce(room) {
  if (room.status !== "playing" || !room.match) return { stepped: false };
  const m = room.match;
  const cur = m.round.currentIdx;
  const p = m.players[cur];
  if (!p.isAI) return { stepped: false, waitingOnHuman: true };
  const mv = E.aiMove(m, cur);
  if (!mv) return { stepped: false };
  const res = E.applyMove(m, p.id, mv);
  if (!res.ok) return { stepped: false, error: res.error };
  if (m.round.over) room.status = "over";
  return { stepped: true, over: m.round.over, by: cur, move: mv };
}

export function currentIsAI(room) {
  if (room.status !== "playing" || !room.match) return false;
  return room.match.players[room.match.round.currentIdx].isAI;
}

// ---- views -----------------------------------------------------------------
export function lobbyView(room, token) {
  return {
    type: "lobby",
    roomId: room.roomId,
    status: room.status,
    capacity: room.capacity,
    isPrivate: room.isPrivate,
    youAreHost: token === room.hostToken,
    yourSeat: seatIndexOf(room, token),
    invite: token === room.hostToken ? room.inviteToken : undefined,
    seats: room.seats.map((s) =>
      s ? { name: s.name, isAI: s.isAI, connected: s.connected, busted: s.bustedOut, empty: false }
        : { empty: true }
    ),
  };
}

export function viewForToken(room, token) {
  if (!room.match) return lobbyView(room, token);
  const v = E.viewFor(room.match, token);
  v.type = "game";
  v.roomId = room.roomId;
  v.status = room.status;
  v.youAreHost = token === room.hostToken;
  v.seats = room.seats.map((s) => ({ name: s.name, isAI: s.isAI, connected: s.connected, busted: s.bustedOut }));
  return v;
}

export function addChat(room, token, text) {
  const i = seatIndexOf(room, token);
  const name = i >= 0 ? room.seats[i].name : "??";
  const line = { name, text: String(text).slice(0, 200).replace(/[<>]/g, ""), at: Date.now() };
  room.chat.push(line);
  if (room.chat.length > 100) room.chat.shift();
  return line;
}
