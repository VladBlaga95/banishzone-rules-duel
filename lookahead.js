// BanishZone Rules Duel — the bot looking ahead.
// Copyright (C) 2026 BanishZone. Licensed under the GNU Affero General Public License v3 or later (see LICENSE.md).
//
// The engine is deterministic and fast, so before a choice that matters on its own turn, the bot tries each move
// it's allowed, plays the rest of its turn out with its plain rules (bot.js), and keeps the move that leaves it
// best placed (score()). Fair play: in those trials its opponent never responds (it doesn't use what's in your
// hand), and it looks no further than its own turn (not at either player's next draws).
//
// A trial is played on the duel itself, then taken back: the engine's whole state is its WebAssembly memory, so
// that memory is copied once before the trials and put back after each (`live`) — a few milliseconds a move,
// however long the duel has been. Without `live` (an engine whose memory can't be reached), each trial is a copy
// of the duel made from its start — the same seed and every answer given so far — which costs a new duel and
// the whole duel played again, a move.
//
//   const choose = lookahead({ lib, makeDuel, decide, seat, fix, live });
//   choose(ask, answers, ctx) → the answer to give, or null (nothing worth looking ahead for: use decide)
//     makeDuel() → a fresh duel, started, as the real one was (seed, Decks); answers: every answer given so far;
//     ctx: the bot's context (turn, phase, level…) — a copy is used in the trials, its handle the trial's
//     fix(r) → an answer as the engine takes it; live: { handle() the duel, heap() the engine's memory (a
//     Uint8Array — asked for each time: it's another once it has grown), quiet(on) no errors reported meanwhile }
const Q = 0x1 | 0x2 | 0x100 | 0x200;
const LOC = { HAND: 2, MZONE: 4, SZONE: 8, GRAVE: 16, REMOVED: 32 };
const ASK = new Set([10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 132, 140, 141, 142, 143]);
const WAITING = 1, END = 0, CONTINUE = 2;

// the moves to try at a prompt (null: just use the plain rules)
function candidates(ask) {
  const out = [];
  switch (ask.type) {
    case 11:   // main phase: every summon, Set and activation, and moving on
      ask.summons.forEach((_, i) => out.push({ type: 1, action: 0, index: i }));
      ask.special_summons.forEach((_, i) => out.push({ type: 1, action: 1, index: i }));
      ask.activates.forEach((_, i) => out.push({ type: 1, action: 5, index: i }));
      ask.monster_sets.forEach((_, i) => out.push({ type: 1, action: 3, index: i }));
      ask.spell_sets.forEach((_, i) => out.push({ type: 1, action: 4, index: i }));
      if (ask.to_bp) out.push({ type: 1, action: 6, index: null });
      if (ask.to_ep) out.push({ type: 1, action: 7, index: null });
      break;
    case 10:   // battle: each attack, an activation, moving on
      ask.attacks.forEach((_, i) => out.push({ type: 0, action: 1, index: i }));
      ask.chains.forEach((_, i) => out.push({ type: 0, action: 0, index: i }));
      if (ask.to_m2) out.push({ type: 0, action: 2, index: null });
      if (ask.to_ep) out.push({ type: 0, action: 3, index: null });
      break;
    case 15:   // one card to choose (what to search, what to target, what to summon)
      if (ask.min !== 1 || ask.max !== 1) return null;
      ask.selects.forEach((_, i) => out.push({ type: 5, indicies: [i] }));
      break;
    case 14:   // an effect to choose
      ask.options.forEach((_, i) => out.push({ type: 4, index: i }));
      break;
    case 12:   // an optional effect: use it or not
      out.push({ type: 2, yes: true }, { type: 2, yes: false });
      break;
    case 16:   // its own chances to chain on its turn (its triggers)
      if (!ask.selects.length) return null;
      ask.selects.forEach((_, i) => out.push({ type: 8, index: i }));
      if (!ask.forced) out.push({ type: 8, index: null });
      break;
    default:
      return null;
  }
  return out.length > 1 ? out : null;
}

// its opponent in the trials: never responds, takes the first of anything it must choose
function passive(ask, decide, ctx) {
  switch (ask.type) {
    case 16: return { type: 8, index: ask.forced ? 0 : null };
    case 12: return { type: 2, yes: false };
    case 13: return { type: 3, yes: false };
    case 11: return { type: 1, action: ask.to_ep ? 7 : 6, index: null };
    case 10: return { type: 0, action: ask.to_ep ? 3 : 2, index: null };
    default: return decide(ask, ctx);
  }
}

// how well placed `seat` is: its monsters (their ATK, a face-down one a fair guess), its Spells / Traps, its hand,
// its Life Points — against its opponent's
function score(lib, h, seat) {
  const q = (p, l) => lib.duelQueryLocation(h, { flags: Q, controller: p, location: l, overlaySequence: 0 }).filter(c => c && c.code !== undefined);
  const lp = lib.duelQueryField(h).players.map(p => p.lp);
  const value = p => {
    let v = 0;
    for (const c of q(p, LOC.MZONE)) v += 8 + ((c.position & 0x5) ? Math.max(c.attack || 0, (c.position & 0x4) ? (c.defense || 0) * .7 : 0) / 100 : 12);
    v += q(p, LOC.SZONE).length * 5;
    v += q(p, LOC.HAND).length * 3.5;
    v += lp[p] / 450;
    return v;
  };
  return value(seat) - value(1 - seat);
}

const BUDGET_MS = 600;         // (a choice's trials stop here — the best of those tried: a slow phone still plays on)

export function lookahead({ lib, makeDuel, decide, seat, fix = r => r, live = null }) {
  // the duel `d`, waiting at the prompt: `r` given, the rest of the turn played out; its score
  function playout(d, r, ctx) {
    lib.duelSetResponse(d, fix(r));
    const c = { ...ctx, lib, handle: d, acts: {}, trigger: {} };
    for (let n = 0; n < 2500; n++) {
      const st = lib.duelProcess(d);
      let ask = null;
      for (const m of lib.duelGetMessage(d)) {
        if (m.type === 5) return m.player === seat ? 1e4 : -1e4;      // (a win, a loss)
        if (m.type === 40) return score(lib, d, seat);                 // (its turn over: as it stands)
        if (m.type === 41) c.phase = m.phase === 0x100 ? 'main2' : String(m.phase);
        if (m.type === 70) c.trigger = { by: m.controller, kind: 'chain' };
        if (ASK.has(m.type)) ask = m;
      }
      if (st === END) break;
      if (st === CONTINUE || !ask) continue;
      lib.duelSetResponse(d, fix(ask.player === seat ? decide(ask, c) : passive(ask, decide, c)));
    }
    return score(lib, d, seat);
  }
  // a trial in a copy of the duel: made as the real one was, replayed to now, then played out
  function replayed(answers, r, ctx) {
    const d = makeDuel();
    try {
      let i = 0, st;
      // (replayed: each answer given at its prompt, as it was — what it says in between isn't read)
      while (i < answers.length) {
        st = lib.duelProcess(d);
        if (st === END) return -1e4;
        if (st === WAITING) lib.duelSetResponse(d, fix(answers[i++]));
      }
      // (on to the same prompt — the engine may take a few steps to get there: then this move)
      do { st = lib.duelProcess(d); lib.duelGetMessage(d); } while (st === CONTINUE);
      if (st !== WAITING) return score(lib, d, seat);
      return playout(d, r, ctx);
    } catch {
      return -1e5;
    } finally {
      try { lib.destroyDuel(d); } catch {}
    }
  }
  return function choose(ask, answers, ctx, max = 14) {
    if (ask.player !== seat) return null;
    let cands = candidates(ask);
    if (!cands) return null;
    cands = cands.slice(0, max);
    let best = null, bestScore = -Infinity;
    const scores = [], from = performance.now();
    const keep = sc => { scores.push(sc); if (sc > bestScore + 1e-6) { best = cands[scores.length - 1]; bestScore = sc; } };
    const heap = live && live.heap && live.heap();
    if (heap) {
      // (on the duel itself: its engine's memory as it is now, put back after each trial — and what a trial grew
      //  it by, cleared, as new memory is)
      const snap = heap.slice();
      const back = () => { const h = live.heap(); h.set(snap); if (h.length > snap.length) h.fill(0, snap.length); };
      live.quiet && live.quiet(true);
      try {
        for (const r of cands) {
          let sc;
          try { sc = playout(live.handle(), r, ctx); } catch { sc = -1e5; } finally { back(); }
          keep(sc);
          if (performance.now() - from > BUDGET_MS) break;
        }
      } finally { live.quiet && live.quiet(false); }
    } else {
      for (const r of cands) { keep(replayed(answers, r, ctx)); if (performance.now() - from > BUDGET_MS) break; }
    }
    if (choose.onScores) choose.onScores(ask, cands.slice(0, scores.length), scores);
    return best;
  };
}
