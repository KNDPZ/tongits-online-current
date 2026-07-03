// ============================================================================
// room-core.mjs (v2) — pure room logic with a live roster.
// A room is rebuilt into an engine "match" each round from whoever is seated,
// so seats can empty and fill between rounds (open seats, spectators, duds).
// No real economy: money/pot are cosmetic play-money; W/L/D + G are the stats.
// ============================================================================
import * as E from "./engine.mjs";

export const HUMAN_TURN_MS = 20000;
export const AI_TURN_MS = 8000;
const RESPOND_MS = 20000; // time a human has to challenge/fold a called draw

const AI_NAMES = [
  "Aling Nena","Mang Tonio","Kuya Boy","Ate Vi","Lolo Ben","Tita Baby",
  "Pareng Jun","Mareng Susan","Inting","Dado","Tisoy","Kapitan",
  "Aling Cora","Mang Berto","Bunso","Idol",
];
export function pickAIName(used, rnd = Math.random) {
  const pool = AI_NAMES.filter((n) => !used.includes(n));
  const arr = pool.length ? pool : AI_NAMES;
  return arr[Math.floor(rnd() * arr.length)];
}

// ---- construction ----------------------------------------------------------
// room names: letters, digits and spaces only, max 10 chars (null if empty)
export function cleanRoomName(s) {
  const n = String(s || "").replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 10).trim();
  return n || null;
}

export function createRoom(opts) {
  const {
    roomId, hostToken, hostName, capacity = 3,
    isPrivate = false, passwordHash = null, inviteToken,
    startMoney = 50, ante = 10,
  } = opts;
  const room = {
    roomId, hostToken, capacity, isPrivate, passwordHash, inviteToken,
    name: cleanRoomName(opts.roomName),   // optional custom room name
    startMoney, ante,
    seats: new Array(capacity).fill(null),
    players: {},               // token -> {name,isAI,money,rec,games,connected,spectator}
    status: "lobby",           // lobby | playing | over | closed
    ready: false, mode: null,  // mode: "1v1" | "openseat" | "full"
    aiRoom: false,             // chose "fill with AI & start"
    match: null, roundOrder: [], roundSeat: [],
    dealerSeat: 0, turnDeadline: null, round: 0,
    dud: false, dudReason: null,
    readyNext: [], _lastLeftName: null,
    chat: [],
  };
  addPlayer(room, hostToken, hostName, false);
  room.seats[0] = hostToken;
  return room;
}
function addPlayer(room, token, name, isAI) {
  room.players[token] = {
    name: name || "Player", isAI: !!isAI,
    money: room.startMoney, rec: { w: 0, l: 0, d: 0 }, games: 0,
    connected: false, spectator: false,
  };
}

// ---- seat helpers ----------------------------------------------------------
export function seatIndexOf(room, token) { return room.seats.indexOf(token); }
function occupiedSeats(room) { const o = []; room.seats.forEach((t, i) => { if (t) o.push(i); }); return o; }
function humanTokens(room) { return room.seats.filter((t) => t && !room.players[t].isAI); }
function firstEmpty(room) { return room.seats.indexOf(null); }
function usedNames(room) { return Object.values(room.players).map((p) => p.name); }

// ---- join / reconnect ------------------------------------------------------
export function joinRoom(room, { token, name, providedPasswordHash = null, invite = null }) {
  const at = seatIndexOf(room, token);
  if (at >= 0) {
    room.players[token].connected = true;
    if (name && !room.players[token].isAI) room.players[token].name = name;
    return { ok: true, seat: at, reconnected: true };
  }
  if (room.status === "closed") return { ok: false, error: "room closed" };
  const inviteOk = invite && room.inviteToken && invite === room.inviteToken;
  if (!inviteOk && room.isPrivate) {
    if (!providedPasswordHash || providedPasswordHash !== room.passwordHash)
      return { ok: false, error: "wrong or missing password" };
  }
  const seat = firstEmpty(room);
  if (seat < 0) return { ok: false, error: "room is full" };
  addPlayer(room, token, name, false);
  room.players[token].connected = true;
  // joining a live game -> spectate until the next round is dealt
  room.players[token].spectator = (room.status === "playing");
  room.seats[seat] = token;
  return { ok: true, seat, spectator: room.players[token].spectator };
}

export function setConnected(room, token, connected) {
  if (room.players[token]) room.players[token].connected = connected;
  return seatIndexOf(room, token);
}

// ---- ready / auto-start ----------------------------------------------------
export function setReady(room, token, mode) {
  if (token !== room.hostToken) return { ok: false, error: "only the host" };
  if (room.status !== "lobby") return { ok: false, error: "already started" };
  if (room.capacity === 2) room.mode = "1v1";
  else {
    if (mode !== "openseat" && mode !== "full") return { ok: false, error: "choose an auto-start option" };
    room.mode = mode;
  }
  room.ready = true; room.aiRoom = false;
  return { ok: true };
}
// Should a READY human room auto-start now?
export function shouldAutoStart(room) {
  if (!room.ready || room.status !== "lobby") return false;
  const humans = humanTokens(room).length;
  if (room.capacity === 2) return humans >= 2;
  if (room.mode === "full") return humans >= 3;
  if (room.mode === "openseat") return humans >= 2;   // start, keep a seat open
  return false;
}

// ---- building a round from the current seats -------------------------------
export function dealRound(room, dealerSeatHint, seed, rnd = Math.random) {
  const seats = occupiedSeats(room);
  if (seats.length < 2) return { ok: false, error: "need 2 players" };
  // everyone seated is now an active participant (spectators get dealt in)
  seats.forEach((si) => { room.players[room.seats[si]].spectator = false; });
  const tokens = seats.map((si) => room.seats[si]);
  const defs = tokens.map((t) => ({ id: t, name: room.players[t].name, isAI: room.players[t].isAI }));
  room.match = E.createMatch({ players: defs, startMoney: room.startMoney, ante: room.ante, seed });
  // carry money/records across rounds (cosmetic); free rebuy if "broke"
  room.match.players.forEach((p, k) => {
    const sp = room.players[tokens[k]];
    p.money = sp.money >= room.ante ? sp.money : room.startMoney;
    p.rec = { ...sp.rec };
  });
  room.roundOrder = tokens;
  room.roundSeat = seats;
  let dealerEng = 0;
  if (Number.isInteger(dealerSeatHint)) { const k = seats.indexOf(dealerSeatHint); if (k >= 0) dealerEng = k; }
  else dealerEng = Math.floor(rnd() * seats.length);
  room.dealerSeat = seats[dealerEng];
  E.startRound(room.match, dealerEng);
  room.status = "playing";
  room.dud = false; room.dudReason = null;
  room.readyNext = []; room._lastLeftName = null;
  room.round++;
  return { ok: true };
}

// Host: instant game vs AI (fills empty seats with AI). Not listed publicly.
export function startMatch(room, { seed, rnd = Math.random } = {}) {
  if (room.status !== "lobby") return { ok: false, error: "already started" };
  if (humanTokens(room).length < 1) return { ok: false, error: "need a player" };
  room.aiRoom = true; room.ready = false;
  for (let i = 0; i < room.capacity; i++) {
    if (!room.seats[i]) {
      const tok = "ai:" + i + ":" + Math.floor(rnd() * 1e6);
      addPlayer(room, tok, pickAIName(usedNames(room), rnd), true);
      room.seats[i] = tok;
    }
  }
  return dealRound(room, undefined, seed, rnd);
}

// Deal the next round from whoever is seated now.
export function nextRound(room, { seed, rnd = Math.random } = {}) {
  if (room.status !== "over") return { ok: false, error: "round not over" };
  // AI rooms: refill any empty seats so they always play full
  if (room.aiRoom) {
    for (let i = 0; i < room.capacity; i++) if (!room.seats[i]) {
      const tok = "ai:" + i + ":" + Math.floor(rnd() * 1e6);
      addPlayer(room, tok, pickAIName(usedNames(room), rnd), true);
      room.seats[i] = tok;
    }
  }
  if (occupiedSeats(room).length < 2) { room.status = "lobby"; return { ok: false, error: "not enough players" }; }
  const hint = seatIndexOf(room, room._nextDealerToken) >= 0 ? seatIndexOf(room, room._nextDealerToken) : undefined;
  return dealRound(room, hint, seed, rnd);
}

// ---- moves -----------------------------------------------------------------
export function currentIsAI(room) {
  if (room.status !== "playing" || !room.match) return false;
  return room.match.players[room.match.round.currentIdx].isAI;
}
export function inChallenge(room) { return !!(room.match && room.match.round.phase === "challenge"); }
export function turnMsFor(room) {
  if (inChallenge(room)) return RESPOND_MS;
  return currentIsAI(room) ? AI_TURN_MS : HUMAN_TURN_MS;
}
function engIdxOfToken(room, token) { return room.roundOrder.indexOf(token); }

export function humanMove(room, token, mv) {
  if (room.status !== "playing" || !room.match) return { ok: false, error: "not playing" };
  const idx = engIdxOfToken(room, token);
  if (idx < 0) return { ok: false, error: "you're spectating this round" };
  // a challenge response can come from any pending responder, not just the current player
  if (mv && mv.type === "respond") {
    const res = E.applyMove(room.match, token, mv);
    if (res.ok && room.match.round.over) finishRound(room);
    return res;
  }
  if (idx !== room.match.round.currentIdx) return { ok: false, error: "not your turn" };
  if (room.match.players[idx].isAI) return { ok: false, error: "AI seat" };
  const res = E.applyMove(room.match, token, mv);
  if (res.ok && room.match.round.over) finishRound(room);
  return res;
}
export function stepAIOnce(room) {
  if (room.status !== "playing" || !room.match) return { stepped: false };
  const r = room.match.round;
  if (r.phase === "challenge") {
    if (!r.call) return { stepped: false };
    const aiIdx = r.call.pending.find((i) => room.match.players[i].isAI);
    if (aiIdx === undefined) return { stepped: false, waitingOnHuman: true };
    const mv = E.aiMove(room.match, aiIdx);
    if (!mv) return { stepped: false };
    const res = E.applyMove(room.match, room.match.players[aiIdx].id, mv);
    if (!res.ok) return { stepped: false, error: res.error };
    if (room.match.round.over) finishRound(room);
    return { stepped: true, over: room.match.round.over };
  }
  const cur = r.currentIdx;
  if (!room.match.players[cur].isAI) return { stepped: false, waitingOnHuman: true };
  const m = E.aiMove(room.match, cur);
  if (!m) return { stepped: false };
  const res = E.applyMove(room.match, room.match.players[cur].id, m);
  if (!res.ok) return { stepped: false, error: res.error };
  if (room.match.round.over) finishRound(room);
  return { stepped: true, over: room.match.round.over };
}
// On responder timeout: fold everyone who hasn't answered (a safe default).
export function autoFoldPending(room) {
  if (!inChallenge(room)) return { ok: false };
  const r = room.match.round;
  for (const i of [...r.call.pending]) {
    E.applyMove(room.match, room.match.players[i].id, { type: "respond", decision: "fold" });
  }
  if (room.match.round.over) finishRound(room);
  return { ok: true };
}
export function autoPlay(room) {
  if (room.status !== "playing" || !room.match) return { ok: false };
  const idx = room.match.round.currentIdx;
  const id = room.match.players[idx].id;
  if (room.match.round.phase === "draw") E.applyMove(room.match, id, { type: "draw" });
  if (!room.match.round.over && room.match.round.phase === "play") {
    const low = room.match.round.hands[idx].slice().sort((a, b) => E.cardPoints(a) - E.cardPoints(b))[0];
    if (low) E.applyMove(room.match, id, { type: "discard", card: E.cardId(low) });
  }
  if (room.match.round.over) finishRound(room);
  return { ok: true };
}
function finishRound(room) {
  if (room.status === "over") return;
  room.status = "over";
  room.readyNext = [];
  // sync cosmetic money + records back to the persistent roster (skip if dud)
  room.match.players.forEach((p, k) => {
    const sp = room.players[room.roundOrder[k]];
    if (!sp) return;
    sp.money = p.money;
    if (!room.dud) { sp.rec = { ...p.rec }; sp.games = (sp.games || 0) + 1; }
  });
  if (room.match.round.result && !room.dud)
    room._nextDealerToken = room.roundOrder[room.match.round.result.nextDealer];
}

// Between rounds: each human readies up; AI is always ready. When everyone's
// ready, the caller should deal the next round.
export function readyNextUp(room, token) {
  if (room.status !== "over") return { ok: false, error: "round not over" };
  const seat = seatIndexOf(room, token);
  if (seat < 0) return { ok: false, error: "not seated" };
  if (room.players[token] && room.players[token].isAI) return { ok: false, error: "AI auto-readies" };
  if (!room.readyNext.includes(token)) room.readyNext.push(token);
  const humans = humanTokens(room);
  const allReady = humans.length > 0 && humans.every((t) => room.readyNext.includes(t));
  return { ok: true, allReady };
}

// ---- leaving (the heart of the lifecycle) ----------------------------------
// Returns { left, dud, dudReason, closed, kick:[tokens], dealNext, becameAI }
export function leaveRoom(room, token, { rnd = Math.random } = {}) {
  const seat = seatIndexOf(room, token);
  if (seat < 0) return { left: false };
  const name = room.players[token] ? room.players[token].name : "A player";
  const wasParticipant = room.status === "playing" && engIdxOfToken(room, token) >= 0;
  const out = { left: true, dud: false, closed: false, kick: [], dealNext: false, becameAI: false, name };

  if (room.status === "playing" && room.aiRoom) {
    // AI room: replace the leaver's seat with AI and keep the round going
    const aiName = pickAIName(usedNames(room), rnd);
    const aiTok = "ai:" + seat + ":" + Math.floor(rnd() * 1e6);
    delete room.players[token];
    addPlayer(room, aiTok, aiName, true);
    room.seats[seat] = aiTok;
    if (wasParticipant) {            // hand the live engine seat to the AI
      const ei = room.roundOrder.indexOf(token);
      room.roundOrder[ei] = aiTok;
      room.match.players[ei].id = aiTok;
      room.match.players[ei].isAI = true;
      room.match.players[ei].name = aiName;
    }
    out.becameAI = true;
    if (humanTokens(room).length === 0) { room.status = "closed"; out.closed = true; }
    return out;
  }

  // human room (or lobby): vacate the seat
  room.seats[seat] = null;
  delete room.players[token];
  room._lastLeftName = name;
  room.readyNext = room.readyNext.filter((t) => room.seats.includes(t));
  if (token === room.hostToken) {
    const h = humanTokens(room)[0];
    if (h) room.hostToken = h;
  }
  const humansLeft = humanTokens(room).length;

  if (room.status === "playing" && wasParticipant) {
    // the in-progress round no longer counts
    room.dud = true; room.dudReason = `${name} left mid-game — this round doesn't count.`;
    room.status = "over";
    room._nextDealerToken = null;
  }

  if (humansLeft === 0) { room.status = "closed"; out.closed = true; return out; }
  if (humansLeft === 1 && (room.status === "over" || room.status === "playing")) {
    // can't play alone -> send the last human back to the lobby, close the room
    out.dud = room.dud; out.dudReason = room.dudReason;
    out.kick = humanTokens(room);
    room.status = "closed"; out.closed = true;
    return out;
  }
  // >=2 humans remain: surface the dud; the remaining players ready up for the next round
  out.dud = room.dud; out.dudReason = room.dudReason;
  return out;
}

// ---- views -----------------------------------------------------------------
export function lobbyView(room, token) {
  return {
    type: "lobby",
    roomId: room.roomId, status: room.status, capacity: room.capacity,
    roomName: room.name || "",
    isPrivate: room.isPrivate, ready: room.ready, mode: room.mode,
    youAreHost: token === room.hostToken,
    yourSeat: seatIndexOf(room, token),
    invite: token === room.hostToken ? room.inviteToken : undefined,
    dud: room.dud, dudReason: room.dudReason,
    seats: room.seats.map((t) => t
      ? { name: room.players[t].name, isAI: room.players[t].isAI, connected: room.players[t].connected, empty: false }
      : { empty: true }),
  };
}

export function isSpectator(room, token) {
  return room.status === "playing" && seatIndexOf(room, token) >= 0 && engIdxOfToken(room, token) < 0;
}

export function viewForToken(room, token) {
  if (!room.match || room.status === "lobby") return lobbyView(room, token);
  const v = E.viewFor(room.match, token);
  v.type = "game";
  v.roomId = room.roomId;
  v.status = room.status;
  v.youAreHost = token === room.hostToken;
  v.spectating = isSpectator(room, token);
  v.dud = room.dud; v.dudReason = room.dudReason;
  v.openSeats = room.seats.filter((t) => t === null).length;
  v.capacity = room.capacity;
  // enrich each round participant with persistent G/rec; attach seat index + ready state
  v.players = v.players.map((p, k) => {
    const tk = room.roundOrder[k];
    const sp = room.players[tk] || {};
    const seated = room.seats.includes(tk);
    return {
      ...p, games: sp.games || 0, seat: room.roundSeat[k],
      seated, isAI: sp.isAI || p.isAI,
      readyNext: sp.isAI ? true : room.readyNext.includes(tk),
    };
  });
  if (room.status === "over") {
    v.youReadyNext = room.readyNext.includes(token);
    v.youSeated = room.seats.includes(token) && !(room.players[token] && room.players[token].isAI);
    v.lastLeft = room._lastLeftName || null;
  }
  v.log = room.match.log.slice(-40);
  if (room.status === "playing" && room.turnDeadline) {
    v.turn = { msLeft: Math.max(0, room.turnDeadline - Date.now()), totalMs: turnMsFor(room), idx: room.match.round.currentIdx };
  }
  return v;
}

// What the Lobby Directory should advertise (null = don't list).
export function lobbyMeta(room) {
  const open = room.seats.filter((t) => t === null).length;
  // list: non-private, non-AI, not closed, has an open seat, and either a READY
  // lobby room or a live human room (so a seat freed by a leaver gets re-listed)
  const live = room.status === "playing" || room.status === "over";
  const listed = !room.isPrivate && !room.aiRoom && room.status !== "closed" && open > 0 && (room.ready || live);
  if (!listed) return null;
  return {
    roomId: room.roomId,
    type: room.capacity === 2 ? "1v1" : "1v2",
    capacity: room.capacity,
    players: room.capacity - open,
    open,
    inProgress: live,
    title: room.name || null,   // custom room name (shown instead of "1v2 table")
    // names of everyone seated (shown in the lobby's table list)
    names: room.seats.filter((t) => t).map((t) => room.players[t].name),
  };
}

export function addChat(room, token, text) {
  const p = room.players[token];
  const line = { name: p ? p.name : "??", text: String(text).slice(0, 120).replace(/[<>]/g, ""), at: Date.now() };
  room.chat.push(line);
  if (room.chat.length > 100) room.chat.shift();
  return line;
}
