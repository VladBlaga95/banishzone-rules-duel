// BanishZone Rules Duel — the bot.
// Copyright (C) 2026 BanishZone. Licensed under the GNU Affero General Public License v3 or later (see LICENSE.md).
//
// The engine says what's legal at every prompt; this picks one. decide(msg, ctx) → the response;
// ctx = { lib, handle, cards (code → {name, type, attack, …}), turn, phase, level, trigger }.
// trigger: what the opponent last did ({by, kind: 'chain' | 'attack' | 'summon'}) — it answers that, not
// its own moves. level: 'easy' (no answers on your turn), 'normal', 'hard' (answers and keeps its traps
// for your attacks and effects).
const T = { MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4 };
const LOC = { DECK: 1, HAND: 2, MZONE: 4, SZONE: 8, GRAVE: 16 };
const Q = { CODE: 1, POSITION: 2, TYPE: 8, ATTACK: 256, DEFENSE: 512 };

// what a spell is worth playing for, by card name (else: play it if the engine allows it)
const SKIP_SPELLS = new Set([]);

function monsters(ctx, p) {
  return ctx.lib.duelQueryLocation(ctx.handle, { flags: Q.CODE | Q.POSITION | Q.ATTACK | Q.DEFENSE, controller: p, location: LOC.MZONE, overlaySequence: 0 })
    .map((c, i) => c && c.code ? { ...c, sequence: i } : null).filter(Boolean);
}
const faceUpAtk = c => (c.position & 1) !== 0;
const atkOf = (ctx, c) => c.attack ?? ((ctx.cards[c.code] || {}).attack || 0);
const power = (ctx, c) => (c.position & 0x5) ? (faceUpAtk(c) ? atkOf(ctx, c) : (c.defense ?? 0)) : 1500;   // (face-down: a guess)

export function decide(msg, ctx) {
  const p = msg.player, me = p, opp = 1 - p;
  const card = code => ctx.cards[code] || { name: String(code), type: 0, attack: 0, level: 0 };
  switch (msg.type) {
    case 11: {   // SELECT_IDLECMD — main phase
      ctx.acts = ctx.acts || {};
      const key = ctx.turn + ':' + ctx.phase;
      const tries = ctx.acts[key] = (ctx.acts[key] || 0) + 1;
      // 1) spells from the hand (draw spells first)
      if (tries < 12) {
        const spells = msg.activates.map((a, i) => ({ a, i, c: card(a.code) }))
          .filter(x => x.a.location === LOC.HAND && (x.c.type & T.SPELL) && !SKIP_SPELLS.has(x.c.name));
        const draw = spells.find(x => /Pot of Greed|Upstart Goblin|Graceful Charity/.test(x.c.name));
        if (draw) return { type: 1, action: 5, index: draw.i };
        const oppMons = monsters(ctx, opp), myMons = monsters(ctx, me);
        const good = spells.find(x => {
          if (/Raigeki|Fissure/.test(x.c.name)) return oppMons.length > 0;
          if (/Dark Hole/.test(x.c.name)) return oppMons.length > myMons.length;
          if (/Mystical Space Typhoon/.test(x.c.name)) return false;     // (kept for their Set cards: chained)
          if (/Book of Moon/.test(x.c.name)) return oppMons.length > 0;
          return true;
        });
        if (good) return { type: 1, action: 5, index: good.i };
      }
      // 2) a summon: the strongest it can (a Tribute Summon when the engine offers one)
      if (msg.summons.length) {
        const best = msg.summons.map((s, i) => ({ i, c: card(s.code) })).sort((a, b) => b.c.attack - a.c.attack)[0];
        const weakest = Math.min(...monsters(ctx, opp).map(c => power(ctx, c)), 99999);
        // (too weak to beat anything they have: Set it instead, when it can be)
        const setI = msg.monster_sets.findIndex(s => s.code === msg.summons[best.i].code);
        if (best.c.attack < weakest && weakest < 99999 && setI >= 0) return { type: 1, action: 3, index: setI };
        return { type: 1, action: 0, index: best.i };
      }
      // 3) Set the Traps (and spells kept for later)
      const setT = msg.spell_sets.findIndex(s => card(s.code).type & T.TRAP);
      if (setT >= 0) return { type: 1, action: 4, index: setT };
      // 4) to battle, if there's something to attack with
      if (msg.to_bp && ctx.phase !== 'main2' && monsters(ctx, me).some(faceUpAtk)) return { type: 1, action: 6, index: null };
      return { type: 1, action: msg.to_ep ? 7 : 6, index: null };
    }
    case 10: {   // SELECT_BATTLECMD
      const oppMons = monsters(ctx, opp);
      const weakest = oppMons.length ? Math.min(...oppMons.map(c => power(ctx, c))) : -1;
      const pick = msg.attacks.map((a, i) => ({ a, i, atk: card(a.code).attack })).sort((x, y) => y.atk - x.atk)
        .find(x => x.a.can_direct || x.atk > weakest);
      if (pick) return { type: 0, action: 1, index: pick.i };
      return { type: 0, action: msg.to_m2 ? 2 : 3, index: null };
    }
    case 16: {   // SELECT_CHAIN — an answer to what the opponent just did (a forced one always)
      if (!msg.selects.length) return { type: 8, index: null };
      if (msg.forced) return { type: 8, index: 0 };
      const t = ctx.trigger || {};
      if (ctx.level === 'easy' || t.by !== opp) return { type: 8, index: null };
      // (its draw spells and the like aren't answers: only what can be used now, on their move)
      return { type: 8, index: 0 };
    }
    case 12: return { type: 2, yes: true };            // SELECT_EFFECTYN
    case 13: return { type: 3, yes: true };            // SELECT_YESNO
    case 14: return { type: 4, index: 0 };             // SELECT_OPTION
    case 15: {   // SELECT_CARD — the opponent's strongest first (targets), else its own
      const order = msg.selects.map((c, i) => ({ c, i, theirs: c.controller !== p, atk: card(c.code).attack || 0 }))
        .sort((a, b) => (b.theirs - a.theirs) || (b.atk - a.atk));
      return { type: 5, indicies: order.slice(0, Math.max(1, msg.min)).map(x => x.i) };
    }
    case 26: {   // SELECT_UNSELECT_CARD
      if (msg.can_finish && (!msg.select_cards.length)) return { type: 7, index: null };
      if (msg.select_cards.length) return { type: 7, index: 0 };
      return { type: 7, index: null };
    }
    case 20: {   // SELECT_TRIBUTE — its weakest
      const order = msg.selects.map((c, i) => ({ i, atk: card(c.code).attack || 0 })).sort((a, b) => a.atk - b.atk);
      return { type: 12, indicies: order.slice(0, msg.min).map(x => x.i) };
    }
    case 18: case 24: {   // SELECT_PLACE / SELECT_DISFIELD — a free zone (a set bit = not allowed)
      const mask = msg.field_mask, places = [];
      const tryZone = (pl, base, loc) => { for (let s = 0; s < 8 && places.length < msg.count; s++) if (!(mask & (1 << (base + s)))) places.push({ player: pl, location: loc, sequence: s }); };
      const own = msg.type === 18 ? p : 1 - p, other = 1 - own;
      tryZone(own, own === p ? 0 : 16, LOC.MZONE); tryZone(own, own === p ? 8 : 24, LOC.SZONE);
      tryZone(other, other === p ? 0 : 16, LOC.MZONE); tryZone(other, other === p ? 8 : 24, LOC.SZONE);
      return { type: msg.type === 18 ? 10 : 9, places };
    }
    case 19: {   // SELECT_POSITION — face-up attack if it's strong enough, else defence
      const c = card(msg.code), weakest = Math.min(...monsters(ctx, opp).map(m => power(ctx, m)), 99999);
      const want = c.attack >= weakest || weakest === 99999 ? [1, 4, 8, 2] : [8, 4, 1, 2];
      return { type: 11, position: want.find(x => msg.positions & x) };
    }
    case 23: {   // SELECT_SUM — enough to reach the amount
      const picks = [], total = () => picks.reduce((s, i) => s + (msg.selects[i].amount & 0xffff), 0);
      for (let i = 0; i < msg.selects.length && total() < msg.amount; i++) picks.push(i);
      return { type: 14, indicies: picks };
    }
    case 22: return { type: 13, counters: msg.cards.map((c, i) => i === 0 ? msg.count : 0) };
    case 25: return { type: 15, order: null };
    case 21: return { type: 15, order: null };
    case 132: return { type: 20, value: 1 };
    case 140: return { type: 16, races: [] };
    case 141: return { type: 17, attributes: [] };
    case 143: return { type: 19, value: 0 };
  }
  throw new Error('the bot has no answer for message ' + msg.type);
}
