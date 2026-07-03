// ============================================================================
// Tong-its headless engine — deterministic, server-authoritative.
// Runs unchanged in a Cloudflare Durable Object and in Node.
//
// Design:
//  - Card = { r:1..13, s:"S"|"H"|"D"|"C" }   (A=1, J=11, Q=12, K=13)
//  - All randomness flows through a seeded RNG stored in state (reproducible).
//  - applyMove(state, playerId, move) validates + mutates + returns {ok,error}.
//  - viewFor(state, viewerId) returns a REDACTED view: the deck and other
//    players' hands are never included (only counts), except at round end
//    where every hand is revealed for verification.
//  - aiMove(state, idx) returns ONE legal move for an AI seat; the room loops
//    applyMove until the AI's turn ends.
// ============================================================================

export const SUITS = ["S", "H", "D", "C"];
export const RED = new Set(["H", "D"]);
const RANK_LABEL = { 1: "A", 11: "J", 12: "Q", 13: "K" };

export function rankLabel(r) { return RANK_LABEL[r] || String(r); }
export function cardId(c) { return `${c.r}${c.s}`; }
export function cardLabel(c) { return `${rankLabel(c.r)}${c.s}`; }
export function cardPoints(c) { return c.r; } // A=1 .. K=13

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ r, s });
  return d;
}

// ---- seeded RNG (mulberry32) ----------------------------------------------
function rngNext(state) {
  let a = state.rngV | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  state.rngV = a;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffleInPlace(arr, state) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext(state) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- meld logic ------------------------------------------------------------
export function isSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const r = cards[0].r;
  if (!cards.every((c) => c.r === r)) return false;
  return new Set(cards.map((c) => c.s)).size === cards.length;
}
export function isRun(cards) {
  if (cards.length < 3) return false;
  const s = cards[0].s;
  if (!cards.every((c) => c.s === s)) return false;
  const rs = cards.map((c) => c.r).sort((a, b) => a - b);
  for (let i = 1; i < rs.length; i++) if (rs[i] !== rs[i - 1] + 1) return false;
  return true;
}
export function isValidMeld(cards) { return isSet(cards) || isRun(cards); }
export function meldType(cards) { return isSet(cards) ? "set" : isRun(cards) ? "run" : null; }

export function canAddToMeld(meld, card) {
  const cs = meld.cards;
  if (cs.some((c) => c.r === card.r && c.s === card.s)) return false;
  if (meld.type === "set")
    return card.r === cs[0].r && cs.length < 4 && !cs.some((c) => c.s === card.s);
  if (card.s !== cs[0].s) return false;
  const rs = cs.map((c) => c.r).sort((a, b) => a - b);
  return (
    (card.r === rs[0] - 1 && card.r >= 1) ||
    (card.r === rs[rs.length - 1] + 1 && card.r <= 13)
  );
}

// Greedy disjoint meld finder (sets first, then runs). Used for scoring + AI.
export function findMelds(hand) {
  let pool = hand.slice();
  const melds = [];
  const byRank = {};
  for (const c of pool) (byRank[c.r] = byRank[c.r] || []).push(c);
  for (const r in byRank)
    if (byRank[r].length >= 3) {
      melds.push({ type: "set", cards: byRank[r].slice() });
      pool = pool.filter((c) => c.r !== +r);
    }
  for (const s of SUITS) {
    const suited = pool.filter((c) => c.s === s).sort((a, b) => a.r - b.r);
    let i = 0;
    while (i < suited.length) {
      let j = i;
      while (j + 1 < suited.length && suited[j + 1].r === suited[j].r + 1) j++;
      if (j - i + 1 >= 3) {
        const run = suited.slice(i, j + 1);
        melds.push({ type: "run", cards: run });
        const ids = new Set(run.map(cardId));
        pool = pool.filter((c) => !ids.has(cardId(c)));
      }
      i = j + 1;
    }
  }
  return melds;
}
// Returns the cards (incl. `card`) that form a meld with the hand, or null.
export function buildMeldWithCard(hand, card) {
  const same = hand.filter((c) => c.r === card.r && c.s !== card.s);
  const used = new Set([card.s]);
  const picks = [];
  for (const c of same) if (!used.has(c.s)) { picks.push(c); used.add(c.s); }
  if (picks.length >= 2) return [card, ...picks].slice(0, 4);
  const present = new Map();
  hand.forEach((c) => { if (c.s === card.s) present.set(c.r, c); });
  present.set(card.r, card);
  for (let start = card.r - 2; start <= card.r; start++) {
    if (start < 1 || start + 2 > 13) continue;
    if (present.has(start) && present.has(start + 1) && present.has(start + 2)) {
      let lo = start, hi = start + 2;
      while (present.has(lo - 1) && lo - 1 >= 1) lo--;
      while (present.has(hi + 1) && hi + 1 <= 13) hi++;
      const run = [];
      for (let r = lo; r <= hi; r++) run.push(present.get(r));
      if (run.some((c) => cardId(c) === cardId(card))) return run;
    }
  }
  return null;
}
export function meldExclusion(cards) {
  const ids = new Set();
  findMelds(cards).forEach((m) => m.cards.forEach((c) => ids.add(cardId(c))));
  return ids;
}
// Counting points = sum of cards NOT part of any in-hand meld.
export function handCounted(hand) {
  const ex = meldExclusion(hand);
  return hand.filter((c) => !ex.has(cardId(c))).reduce((s, c) => s + cardPoints(c), 0);
}
export function sortHand(h) {
  return h.slice().sort((a, b) =>
    a.s === b.s ? a.r - b.r : SUITS.indexOf(a.s) - SUITS.indexOf(b.s)
  );
}

// ---- match / round lifecycle ----------------------------------------------
export function createMatch({ players, startMoney = 50, ante = 10, seed }) {
  // players: [{ id, name, isAI }]
  const ps = players.map((p) => ({
    id: p.id, name: p.name, isAI: !!p.isAI,
    money: startMoney, rec: { w: 0, l: 0, d: 0 }, connected: true,
  }));
  return {
    version: 0,
    startMoney, ante,
    rngV: (seed == null ? (Math.random() * 2 ** 31) | 0 : seed | 0),
    players: ps,
    round: { active: false, over: false, phase: "idle" },
    log: [],
  };
}

function logEvent(state, text) {
  state.log.push(text);
  if (state.log.length > 120) state.log.shift();
}

export function canAnte(state, idx) { return state.players[idx].money >= state.ante; }

// Reset an AI seat to a fresh buy-in (room supplies the new name).
export function replaceSeat(state, idx, name) {
  const p = state.players[idx];
  const old = p.name;
  p.name = name;
  p.money = state.startMoney;
  p.rec = { w: 0, l: 0, d: 0 };
  logEvent(state, `${old} busted out — ${name} buys in for $${state.startMoney}.`);
}

// Deal a new round. Assumes the room already replaced busted AIs / handled a
// busted human. Takes antes, deals 12 each (+1 to dealer), empty discard.
export function startRound(state, dealerIdx) {
  const N = state.players.length;
  // antes
  let pot = 0;
  for (const p of state.players) { p.money -= state.ante; pot += state.ante; }
  const deck = shuffleInPlace(makeDeck(), state);
  const hands = state.players.map(() => []);
  for (let n = 0; n < 12; n++) for (let pi = 0; pi < N; pi++) hands[pi].push(deck.pop());
  hands[dealerIdx].push(deck.pop());
  for (let pi = 0; pi < N; pi++) hands[pi] = sortHand(hands[pi]);
  state.round = {
    active: true, over: false,
    dealerIdx, currentIdx: dealerIdx, phase: "play", // dealer plays first w/o drawing
    turnCount: 0, lastMeldTurn: -999, lastSapawTurn: -999, lastMover: null,
    selfSapawTurn: state.players.map(() => -999),   // last turn this player laid off (sapaw)
    meldSapawedTurn: state.players.map(() => -999),  // last turn someone laid off ONTO this player's meld
    call: null,                                      // active draw/challenge, when phase==="challenge"
    pot, stock: deck, discard: [],
    hands, melds: state.players.map(() => []), hasMelded: state.players.map(() => false),
    result: null,
  };
  state.version++;
  logEvent(state, `New round. Pot $${pot}. ${state.players[dealerIdx].name} deals and starts.`);
  return state;
}

// ---- helpers ---------------------------------------------------------------
function byId(state, id) { return state.players.findIndex((p) => p.id === id); }
function handOf(state, idx) { return state.round.hands[idx]; }
function findCard(hand, id) { return hand.find((c) => cardId(c) === id); }

export function callViable(state, idx) {
  const r = state.round;
  if (!r.active || r.over) return false;
  if (!r.hasMelded[idx]) return false;            // need at least one exposed meld
  const N = state.players.length;
  const prevTurn = r.turnCount - N;               // this player's previous turn number
  // can't call if you laid off on a meld on your previous turn ...
  if (r.selfSapawTurn[idx] >= prevTurn) return false;
  // ... or if anyone laid off ONTO your meld since your previous turn
  if (r.meldSapawedTurn[idx] >= prevTurn) return false;
  return true;
}

function allHandCards(state, idx) { return state.round.hands[idx]; }
function isWin(state, idx) {
  const r = state.round;
  const hand = r.hands[idx];
  return hand.length === 0 || (r.hasMelded[idx] && handCounted(hand) === 0);
}

function endTurn(state) {
  const r = state.round;
  r.lastMover = r.currentIdx;
  if (r.stock.length === 0) { settle(state, null, "stockout"); return; }
  r.turnCount++;
  r.currentIdx = (r.currentIdx + 1) % state.players.length;
  r.phase = "draw";
}

function settle(state, tongitsIdx, reason) {
  const r = state.round;
  const N = state.players.length;
  let winners, draw = false;
  if (reason === "tongits") {
    winners = [tongitsIdx];
  } else {
    const rows = state.players.map((_, i) => ({ i, pts: handCounted(r.hands[i]), burned: !r.hasMelded[i] }));
    const eligible = rows.filter((x) => !x.burned);
    const pool = eligible.length ? eligible : rows;
    const low = Math.min(...pool.map((x) => x.pts));
    winners = pool.filter((x) => x.pts === low).map((x) => x.i);
    draw = winners.length > 1;
  }
  // payout
  const pot = r.pot;
  const share = Math.floor(pot / winners.length);
  let rem = pot - share * winners.length;
  const payouts = {};
  winners.forEach((w, k) => {
    const amt = share + (k < rem ? 1 : 0);
    state.players[w].money += amt;
    payouts[w] = amt;
  });
  r.pot = 0;
  // records
  state.players.forEach((p, i) => {
    if (winners.includes(i)) p.rec[draw ? "d" : "w"]++; else p.rec.l++;
  });
  // dealer for next round = a winner (random among ties via seeded rng)
  const nextDealer = winners[Math.floor(rngNext(state) * winners.length)];
  const emptied = reason === "tongits" && r.hands[tongitsIdx].length === 0;
  r.over = true;
  r.active = false;
  r.phase = "over";
  r.result = {
    reason, winners, draw, payouts, nextDealer, emptied,
    counts: state.players.map((_, i) => handCounted(r.hands[i])),
  };
  state.version++;
  const names = winners.map((w) => state.players[w].name).join(" & ");
  logEvent(state, draw
    ? `Draw — pot split between ${names}.`
    : `${state.players[winners[0]].name} wins $${payouts[winners[0]]} (${reason}).`);
}

// ---- draw / challenge ------------------------------------------------------
function beginCall(state, caller) {
  const r = state.round;
  const responders = [], autoFold = [];
  state.players.forEach((_, i) => {
    if (i === caller) return;
    if (r.hasMelded[i]) responders.push(i);  // has a meld -> may challenge or fold
    else autoFold.push(i);                   // no meld -> automatically folded (burned)
  });
  r.phase = "challenge";
  r.call = { caller, pending: [...responders], responders, decisions: {}, order: [], autoFold };
  state.version++;
  logEvent(state, `${state.players[caller].name} called a draw — opponents with a meld may challenge or fold.`);
  if (r.call.pending.length === 0) resolveCall(state);
}

function resolveCall(state) {
  const r = state.round, c = r.call;
  const counts = state.players.map((_, i) => handCounted(r.hands[i]));
  const challengers = c.order.filter((i) => c.decisions[i] === "challenge");
  const folders = c.order.filter((i) => c.decisions[i] === "fold");
  const shown = [c.caller, ...challengers];
  // pick the winner among those who showed: lowest count;
  // tie -> a challenger beats the caller; tie among challengers -> the LAST to challenge wins.
  const isChal = (i) => i !== c.caller;
  const better = (a, b) => {
    if (counts[a] !== counts[b]) return counts[a] < counts[b];
    if (isChal(a) !== isChal(b)) return isChal(a);            // challenger over caller
    if (isChal(a) && isChal(b)) return c.order.indexOf(a) > c.order.indexOf(b); // later challenger
    return false;
  };
  let best = shown[0];
  for (const i of shown) if (better(i, best)) best = i;
  finishCall(state, { winner: best, caller: c.caller, challengers, folders, autoFold: c.autoFold, shown, counts });
}

function finishCall(state, info) {
  const r = state.round;
  const { winner, caller, challengers, folders, autoFold, shown, counts } = info;
  const winners = [winner];
  const pot = r.pot;
  const payouts = {};
  winners.forEach((w) => { state.players[w].money += pot; payouts[w] = pot; });
  r.pot = 0;
  state.players.forEach((p, i) => { if (i === winner) p.rec.w++; else p.rec.l++; });
  r.over = true; r.active = false; r.phase = "over";
  r.result = {
    reason: "call", caller, winners, draw: false,
    challengers, folders, autoFold, shown,
    payouts, nextDealer: winner, emptied: false, counts,
  };
  state.version++;
  logEvent(state, `${state.players[winner].name} wins the draw with the lowest count (${counts[winner]}).`);
  r.call = null;
}


// End the live round with no winner (e.g. a participant left mid-game).
// Antes are refunded, the pot clears, and the round is closed in the same
// shape as a normal ending so clients render the "Round voided" screen.
export function voidRound(state, reason) {
  const r = state.round;
  if (!r || !r.active || r.over) return false;
  for (const p of state.players) p.money += state.ante;   // give the antes back
  r.pot = 0;
  r.call = null;                                          // cancel any pending draw-call
  r.over = true; r.active = false; r.phase = "over";
  r.result = {
    reason: "dud", dud: true, winners: [], draw: false,
    payouts: {}, nextDealer: r.dealerIdx, emptied: false,
    counts: state.players.map((_, i) => handCounted(r.hands[i])),
  };
  state.version++;
  logEvent(state, reason || "Round voided.");
  return true;
}

// move types:
//   { type:"draw" }                              (stock)
//   { type:"drawDiscard", cards:[id,...] }       (take top discard + meld)
//   { type:"meld", cards:[id,...] }
//   { type:"sapaw", card:id, owner:idx, meldIdx:n }
//   { type:"discard", card:id }
//   { type:"call" }
export function applyMove(state, playerId, move) {
  const r = state.round;
  if (!r.active || r.over) return fail("round not active");
  const idx = byId(state, playerId);
  if (idx < 0) return fail("unknown player");

  // Challenge response: any pending responder may answer, not just the current player.
  if (move && move.type === "respond") {
    if (r.phase !== "challenge" || !r.call) return fail("no draw to answer");
    if (!r.call.pending.includes(idx)) return fail("not yours to answer");
    const dec = move.decision === "challenge" ? "challenge" : "fold";
    r.call.decisions[idx] = dec;
    r.call.order.push(idx);
    r.call.pending = r.call.pending.filter((i) => i !== idx);
    state.version++;
    logEvent(state, `${state.players[idx].name} ${dec === "challenge" ? "challenged the draw" : "folded"}.`);
    if (r.call.pending.length === 0) resolveCall(state);
    return ok(state);
  }

  if (r.phase === "challenge") return fail("a draw is being answered");
  if (idx !== r.currentIdx) return fail("not your turn");
  const hand = handOf(state, idx);

  switch (move && move.type) {
    case "call": {
      if (r.phase !== "draw") return fail("can only call before drawing");
      if (!callViable(state, idx)) return fail("call not available this turn");
      beginCall(state, idx);
      return ok(state);
    }
    case "draw": {
      if (r.phase !== "draw") return fail("not in draw phase");
      if (r.stock.length === 0) return fail("stock empty");
      const card = r.stock.pop();
      hand.push(card);
      r.phase = "play";
      state.version++;
      logEvent(state, `${state.players[idx].name} drew from the stock.`);
      if (isWin(state, idx)) settle(state, idx, "tongits");
      return ok(state);
    }
    case "drawDiscard": {
      if (r.phase !== "draw") return fail("not in draw phase");
      const top = r.discard[r.discard.length - 1];
      if (!top) return fail("discard pile empty");
      const ids = Array.isArray(move.cards) ? move.cards : [];
      const chosen = ids.map((id) => findCard(hand, id));
      if (chosen.some((c) => !c)) return fail("chosen card not in hand");
      const meldCards = [top, ...chosen];
      if (meldCards.length < 3 || !isValidMeld(meldCards))
        return fail("must take the discard straight into a valid meld");
      r.discard.pop();
      const remove = new Set(ids);
      state.round.hands[idx] = hand.filter((c) => !remove.has(cardId(c)));
      r.melds[idx].push({ type: meldType(meldCards), cards: sortHand(meldCards) });
      r.hasMelded[idx] = true;
      r.lastMeldTurn = r.turnCount;
      r.phase = "play";
      state.version++;
      logEvent(state, `${state.players[idx].name} took ${cardLabel(top)} and melded.`);
      if (isWin(state, idx)) settle(state, idx, "tongits");
      return ok(state);
    }
    case "meld": {
      if (r.phase !== "play") return fail("draw first");
      const ids = Array.isArray(move.cards) ? move.cards : [];
      const chosen = ids.map((id) => findCard(hand, id));
      if (chosen.length < 3 || chosen.some((c) => !c)) return fail("invalid meld selection");
      if (!isValidMeld(chosen)) return fail("not a valid set or run");
      const remove = new Set(ids);
      state.round.hands[idx] = hand.filter((c) => !remove.has(cardId(c)));
      r.melds[idx].push({ type: meldType(chosen), cards: sortHand(chosen) });
      r.hasMelded[idx] = true;
      r.lastMeldTurn = r.turnCount;
      state.version++;
      logEvent(state, `${state.players[idx].name} laid a ${meldType(chosen)}.`);
      if (isWin(state, idx)) settle(state, idx, "tongits");
      return ok(state);
    }
    case "sapaw": {
      if (r.phase !== "play") return fail("draw first");
      const card = findCard(hand, move.card);
      if (!card) return fail("card not in hand");
      const owner = move.owner, mIdx = move.meldIdx;
      const meld = r.melds[owner] && r.melds[owner][mIdx];
      if (!meld) return fail("no such meld");
      if (!canAddToMeld(meld, card)) return fail("card does not fit that meld");
      state.round.hands[idx] = hand.filter((c) => cardId(c) !== cardId(card));
      meld.cards = sortHand(meld.cards.concat([card]));
      r.lastSapawTurn = r.turnCount;
      r.selfSapawTurn[idx] = r.turnCount;        // you laid off this turn
      r.meldSapawedTurn[owner] = r.turnCount;    // owner's meld got laid on
      state.version++;
      logEvent(state, `${state.players[idx].name} sapaw ${cardLabel(card)} onto ${state.players[owner].name}'s ${meld.type}.`);
      if (isWin(state, idx)) settle(state, idx, "tongits");
      return ok(state);
    }
    case "discard": {
      if (r.phase !== "play") return fail("draw first");
      const card = findCard(hand, move.card);
      if (!card) return fail("card not in hand");
      state.round.hands[idx] = hand.filter((c) => cardId(c) !== cardId(card));
      r.discard.push(card);
      state.version++;
      logEvent(state, `${state.players[idx].name} discarded ${cardLabel(card)}.`);
      if (isWin(state, idx)) { settle(state, idx, "tongits"); return ok(state); }
      endTurn(state);
      return ok(state);
    }
    default:
      return fail("unknown move");
  }
  function ok() { return { ok: true }; }
  function fail(error) { return { ok: false, error }; }
}

// ---- server-side AI: one legal move per call -------------------------------
export function aiMove(state, idx) {
  const r = state.round;
  // Answering a called draw — a responder acts even though it isn't their turn.
  if (r.phase === "challenge") {
    if (!r.call || !r.call.pending.includes(idx)) return null;
    const pts = handCounted(r.hands[idx]);
    return { type: "respond", decision: pts <= 12 ? "challenge" : "fold" };
  }
  if (!r.active || r.over || r.currentIdx !== idx) return null;
  const hand = r.hands[idx];
  const N = state.players.length;

  if (r.phase === "draw") {
    // 1) call a draw before drawing only when our hand is genuinely low
    if (callViable(state, idx)) {
      const pts = handCounted(hand);
      const eligible = state.players.map((_, i) => i).filter((i) => r.hasMelded[i]);
      const lowest = Math.min(...eligible.map((i) => handCounted(r.hands[i])));
      const burnedOpp = state.players.some((_, i) => i !== idx && !r.hasMelded[i]);
      if (pts <= lowest && (pts <= 8 || (burnedOpp && pts <= 14))) return { type: "call" };
    }
    // 2) take the discard if it completes a meld
    const top = r.discard[r.discard.length - 1];
    if (top) {
      const built = buildMeldWithCard(hand, top);
      if (built) {
        const cards = built.filter((c) => cardId(c) !== cardId(top)).map(cardId);
        return { type: "drawDiscard", cards };
      }
    }
    return { type: "draw" };
  }

  // play phase: lay highest-value meld, then sapaw, then discard
  const melds = findMelds(hand);
  if (melds.length) {
    melds.sort((a, b) => sum(b.cards) - sum(a.cards));
    return { type: "meld", cards: melds[0].cards.map(cardId) };
  }
  // sapaw: melded AIs lay off freely; a burned AI under threat (an opponent has an
  // exposed meld) lays off to block the call and keep itself in the game
  const oppHasMeld = state.players.some((_, i) => i !== idx && r.hasMelded[i]);
  if (r.hasMelded[idx] || (!r.hasMelded[idx] && oppHasMeld)) {
    for (const card of hand) {
      for (let o = 0; o < N; o++) {
        for (let m = 0; m < r.melds[o].length; m++) {
          if (canAddToMeld(r.melds[o][m], card))
            return { type: "sapaw", card: cardId(card), owner: o, meldIdx: m };
        }
      }
    }
  }
  return { type: "discard", card: cardId(aiChooseDiscard(hand)) };

  function sum(cs) { return cs.reduce((s, c) => s + cardPoints(c), 0); }
}
function aiChooseDiscard(hand) {
  const useful = (c) =>
    hand.some((o) => o !== c && o.r === c.r) ||
    hand.some((o) => o !== c && o.s === c.s && Math.abs(o.r - c.r) >= 1 && Math.abs(o.r - c.r) <= 2);
  let cand = hand.filter((c) => !useful(c));
  if (!cand.length) cand = hand.slice();
  cand.sort((a, b) => cardPoints(b) - cardPoints(a) || b.r - a.r);
  return cand[0];
}

// ---- redacted per-player view ---------------------------------------------
export function viewFor(state, viewerId) {
  const idx = byId(state, viewerId);
  const r = state.round;
  const players = state.players.map((p) => ({
    name: p.name, isAI: p.isAI, money: p.money, rec: p.rec, connected: p.connected,
  }));
  if (!r.active && !r.over) {
    return { version: state.version, ante: state.ante, players, round: { phase: "idle" } };
  }
  return {
    version: state.version,
    ante: state.ante,
    players,
    round: {
      active: r.active, over: r.over, phase: r.phase,
      dealerIdx: r.dealerIdx, currentIdx: r.currentIdx, turnCount: r.turnCount,
      pot: r.pot, lastMover: r.lastMover,
      stockCount: r.stock.length,
      discard: r.discard.slice(),
      melds: r.melds,
      hasMelded: r.hasMelded.slice(),
      handCounts: r.hands.map((h) => h.length),
      you: idx >= 0
        ? { idx, hand: sortHand(r.hands[idx]), counted: handCounted(r.hands[idx]), canCall: callViable(state, idx) }
        : null,
      call: (r.phase === "challenge" && r.call)
        ? {
            caller: r.call.caller,
            pending: r.call.pending.slice(),
            decided: r.call.order.map((i) => ({ idx: i, decision: r.call.decisions[i] })),
            autoFold: r.call.autoFold.slice(),
            youRespond: idx >= 0 && r.call.pending.includes(idx),
          }
        : null,
      result: r.over ? r.result : null,
      // reveal at round end; for a called draw, only the caller and challengers show.
      reveal: r.over ? buildReveal(state, idx) : null,
    },
  };
}

// Light legal-move summary (handy for UI button states / debugging).
export function legalMoves(state, idx) {
  const r = state.round;
  if (r.phase === "challenge") return (r.call && r.call.pending.includes(idx)) ? ["respond"] : [];
  if (!r.active || r.over || r.currentIdx !== idx) return [];
  if (r.phase === "draw") {
    const out = ["draw"];
    if (callViable(state, idx)) out.push("call");
    const top = r.discard[r.discard.length - 1];
    if (top && buildMeldWithCard(r.hands[idx], top)) out.push("drawDiscard");
    return out;
  }
  return ["meld", "sapaw", "discard"];
}

function buildReveal(state) {
  const r = state.round, res = r.result;
  if (res && res.reason === "call") {
    const shown = new Set(res.shown);
    return r.hands.map((h, i) => shown.has(i)
      ? { idx: i, cards: sortHand(h), meldIds: [...meldExclusion(h)], counted: handCounted(h), shown: true,
          caller: i === res.caller, challenger: res.challengers.includes(i) }
      : { idx: i, cards: [], meldIds: [], counted: null, shown: false,
          folded: res.folders.includes(i), burned: res.autoFold.includes(i) });
  }
  return r.hands.map((h, i) => ({ idx: i, cards: sortHand(h), meldIds: [...meldExclusion(h)], counted: handCounted(h), shown: true }));
}
