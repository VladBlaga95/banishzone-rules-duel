// BanishZone Rules Duel — the page's side: the engine's duel drawn on the duel board, your prompts, the log.
// Copyright (C) 2026 BanishZone. Licensed under the GNU Affero General Public License v3 or later (see LICENSE.md).
//
// The engine runs in engine-worker.js; this turns what it sends into the board's states (ComboBoard draws
// them — it gets plain data, as it does from the free table) and turns your taps into its answers.
//   RulesDuel.start({ me: {deck, name}, bot: {deck, name}, level, boards: {mine, theirs}, ui, onEnd, bots? })
//     bots: which seats the bot plays ([false, true]: you against it; [true, true]: two bots, to watch)
//     deck: a Deck Builder deck ({sections: [{title, cards: [{id, name, img, big, count, …}]}]})
//     ui: {prompt(el-builder), log(html), phase(text), zoom(card)} — the page's panels
const T = { MONSTER: 0x1, SPELL: 0x2, TRAP: 0x4, NORMAL: 0x10, TOKEN: 0x4000, LINK: 0x4000000 };
const LOC = { DECK: 1, HAND: 2, MZONE: 4, SZONE: 8, GRAVE: 16, REMOVED: 32, EXTRA: 64 };
const EXTRA_TYPES = 0x40 | 0x2000 | 0x800000 | 0x4000000;     // Fusion, Synchro, Xyz, Link
const ZONE = {
  [LOC.MZONE]: s => ['mm1', 'mm2', 'mm3', 'mm4', 'mm5', 'emz1', 'emz2'][s],
  [LOC.SZONE]: s => ['st1', 'st2', 'st3', 'st4', 'st5', 'fz', 'st1', 'st5'][s],
};
const PHASES = { 1: 'Draw Phase', 2: 'Standby Phase', 4: 'Main Phase 1', 8: 'Battle Phase', 0x10: 'Battle Phase', 0x20: 'Battle Phase',
                 0x40: 'Battle Phase', 0x80: 'Battle Phase', 0x100: 'Main Phase 2', 0x200: 'End Phase' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// (online, as the engine's second player: each message's sides swapped — player / controller 0 always you — and your
//  answers' zones swapped back on their way to the engine)
const SIDE_KEYS = new Set(['player', 'controller', 'triggering_controller']);
const swapSides = x => Array.isArray(x) ? x.map(swapSides)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SIDE_KEYS.has(k) && (v === 0 || v === 1) ? 1 - v : swapSides(v)]))
  : x;

// a Type's and an Attribute's bit is its place here (ANNOUNCE_RACE, ANNOUNCE_ATTRIB)
const RACES = ['Warrior', 'Spellcaster', 'Fairy', 'Fiend', 'Zombie', 'Machine', 'Aqua', 'Pyro', 'Rock', 'Winged Beast', 'Plant', 'Insect', 'Thunder', 'Dragon',
               'Beast', 'Beast-Warrior', 'Dinosaur', 'Fish', 'Sea Serpent', 'Reptile', 'Psychic', 'Divine-Beast', 'Creator God', 'Wyrm', 'Cyberse', 'Illusion'];
const ATTRS = ['EARTH', 'WATER', 'FIRE', 'WIND', 'LIGHT', 'DARK', 'DIVINE'];

/** A Deck Builder deck → the engine's {main, extra} codes, and what each card looks like. */
export function deckCodes(deck, info) {
  const main = [], extra = [];
  for (const sec of deck.sections || []) {
    if (/side/i.test(sec.title)) continue;
    for (const c of sec.cards || []) {
      const code = +c.id;
      if (!code) continue;
      info[code] = info[code] || { id: c.id, name: c.name, img: c.img, big: c.big || c.img, frame: c.frame || '', type: c.type || '' };
      for (let i = 0; i < Math.max(1, c.count || 1); i++) (/extra/i.test(sec.title) ? extra : main).push(code);
    }
  }
  return { main, extra };
}

/** An endboard (the Endboard Builder's state: field zones [card, …materials], hand, GY, banished, flags, lp) → where
 *  each of its cards goes in the engine for the bot's side: {cards: [{code, location, sequence, position}], lp, hidden}.
 *  Hidden cards (a hand card left unknown) can't be played by the engine: counted, left out. */
export function boardPlacements(state, info) {
  const zones = state.zones || {}, flags = state.flags || {}, out = [], tokens = [], mods = [];
  let hidden = 0, tk = 0;
  const F = { mm1: [LOC.MZONE, 0], mm2: [LOC.MZONE, 1], mm3: [LOC.MZONE, 2], mm4: [LOC.MZONE, 3], mm5: [LOC.MZONE, 4], emz1: [LOC.MZONE, 5], emz2: [LOC.MZONE, 6],
              st1: [LOC.SZONE, 0], st2: [LOC.SZONE, 1], st3: [LOC.SZONE, 2], st4: [LOC.SZONE, 3], st5: [LOC.SZONE, 4], fz: [LOC.SZONE, 5] };
  // (a Token: card data made for it — a code no card has, its name, ATK / DEF, Level, Type, Attribute: the engine reads it
  //  through the duel's cardReader, engine-worker.js)
  const token = c => {
    const code = 990000000 + (++tk), d = { code, name: c.name || 'Token', atk: +c.atk || 0, def: +c.def || 0, level: +c.level || 1, race: c.race || '', attribute: c.attribute || '' };
    tokens.push(d);
    info[code] = { id: code, name: d.name, token: true, art: c.art || '', atk: d.atk, def: d.def, level: d.level, race: d.race, attribute: d.attribute, frame: 'token', type: 'Token Monster' };
    return code;
  };
  const known = u => { const c = state.cards[u]; if (c && c.token) return token(c); if (!c || c.unknown || !+c.id) { if (c) hidden++; return 0; }
    const code = +c.id; info[code] = info[code] || { id: c.id, name: c.name, img: c.img, big: c.big || c.img, frame: c.frame || '', type: c.type || '' }; return code; };
  for (const [z, [loc, seq]] of Object.entries(F)) (zones[z] || []).forEach((u, i) => {
    const code = known(u);
    if (!code) return;
    if (i > 0) { out.push({ code, location: 0x80, sequence: seq, position: 1 }); return; }     // (Xyz Material, under the card)
    const f = flags[u] || {}, down = f.face === 'down';
    // (a face-up Pendulum Monster in a Pendulum Zone: there; a monster: Attack / Defense / Set; a Spell or Trap: face-up or Set)
    const pend = loc === LOC.SZONE && (seq === 0 || seq === 4) && !down && /pendulum/i.test(state.cards[u].frame || state.cards[u].type || '');
    if (pend) out.push({ code, location: 0x200, sequence: seq ? 1 : 0, position: 1 });
    else out.push({ code, location: loc, sequence: seq, position: loc === LOC.MZONE ? (down ? 8 : f.pos === 'def' ? 4 : 1) : (down ? 10 : 1) });
    // (its ATK / DEF / Level as changed in the builder: made so by an effect at the start)
    const m = f.mods || {};
    if (loc === LOC.MZONE && !down && (m.atk !== undefined || m.def !== undefined || m.level !== undefined))
      mods.push({ sequence: seq, atk: m.atk, def: m.def, level: m.level });
  });
  for (const [z, loc] of [['hand', LOC.HAND], ['gy', LOC.GRAVE], ['banished', LOC.REMOVED]]) for (const u of zones[z] || []) {
    const code = known(u);
    if (code) out.push({ code, location: loc, sequence: 0, position: loc === LOC.HAND || (flags[u] || {}).face === 'down' ? 10 : 1 });
  }
  return { cards: out, lp: state.lp ?? 8000, hidden, tokens, mods };
}

/** What the engine can't play as written: cards it doesn't know, and cards with an effect but no script
 *  (they'd play as if they had no text). cards: cards.json. */
export function deckCheck(codes, cards, info) {
  const unknown = new Set(), unscripted = new Set();
  for (const code of [...codes.main, ...codes.extra]) {
    const c = cards[code];
    if (!c) { unknown.add(code); continue; }
    const normal = (c[2] & T.NORMAL) && !(c[2] & 0x20) || (c[2] & T.TOKEN);
    if (!c[11] && !normal) unscripted.add(code);
  }
  const nm = code => (info[code] || {}).name || '#' + code;
  return { unknown: [...unknown].map(nm), unscripted: [...unscripted].map(nm), ok: !unknown.size };
}

export function start(o) {
  const info = {};
  // (the bot's side: its deck — or an endboard it pilots, with a deck to play on with, or none: then the practice
  //  ends with your turn)
  const board = o.bot.board ? boardPlacements(o.bot.board, info) : null;
  // (online — o.online: {send(answer)}, the opponent in o.bot — o.seat says which of the engine's players you are: the
  //  coin toss's; the engine's player 0 goes first. Every answer, yours and theirs, comes back through apply(), in the
  //  room's order, so both browsers' engines play the same duel)
  const seat = o.seat ? 1 : 0, sides = x => (seat ? swapSides(x) : x);
  const mineCodes = deckCodes(o.me.deck, info), theirCodes = o.bot.deck ? deckCodes(o.bot.deck, info) : { main: [], extra: [] };
  const decks = seat ? [theirCodes, mineCodes] : [mineCodes, theirCodes];
  // (the Combo Lab's Auto — o.lab: no one across the field; o.hand: your opening hand, those cards out of your Deck;
  //  o.onAnswer(r): each answer you give, to record; o.replay: no prompts — answers come through apply(), and
  //  o.onIdle() says when the engine waits for the next)
  const hand = (o.hand || []).filter(code => { const i = mineCodes.main.indexOf(code); if (i < 0) return false; mineCodes.main.splice(i, 1); return true; });
  const names = Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.name]));
  const who = p => p === 0 ? 'You' : o.bot.name;
  const nm = code => (info[code] || {}).name || 'a card';
  const img = code => (info[code] || {}).img || `https://images.ygoprodeck.com/images/cards_small/${code}.jpg`;
  const big = code => (info[code] || {}).big || `https://images.ygoprodeck.com/images/cards/${code}.jpg`;
  const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  let cards = {}, strs = {}, sys = {};
  fetch((o.scripts || '/duel-scripts/') + 'cards.json').then(r => r.json()).then(c => { cards = c; }).catch(() => {});
  // (each card's effect texts: what an effect's button says — "Special Summon 1 "Power Patron" monster")
  fetch((o.scripts || '/duel-scripts/') + 'strings.json').then(r => r.json()).then(t => { strs = t; }).catch(() => {});
  // (EDOPro's own texts, by number: what a choice says when a script names one — 573 "Add the card(s) to your hand")
  fetch((o.scripts || '/duel-scripts/') + 'system.json').then(r => r.json()).then(t => { sys = t; }).catch(() => {});
  let field = null, ask = null, over = false, winner = -1, uidN = 0, turnPlayer = 0, turns = 0;
  // (each side's foils and frames on its cards — o.me.looks / o.bot.looks: {foils, frames} by "card:<id>", as the
  //  owner's deck brought them — so the other player sees them too)
  const look = (p, code) => {
    const l = (p === 0 ? o.me.looks : o.bot.looks) || {}, k = 'card:' + code, out = {};
    if (l.foils && l.foils[k]) out.foil = l.foils[k];
    if (l.frames && l.frames[k]) out.alt = l.frames[k];
    return out;
  };
  // where each card is: "p:loc:seq" → uid (so a card glides from where it was to where it is)
  let at = {};
  const cardOf = {};            // uid → code

  // ── the engine's field → the board's two states ───────────────────────────────────────────
  function reconcile(f, msgs) {
    // (its moves this time, applied to where the cards were: a card keeps its uid as it goes)
    const was = { ...at }, next = {};
    for (const m of msgs) {
      if (m.type === 50 && m.from && m.to) {               // MOVE
        const k0 = `${m.from.controller}:${m.from.location}:${m.from.sequence}`, k1 = `${m.to.controller}:${m.to.location}:${m.to.sequence}`;
        if (was[k0]) { was['moved:' + k1] = was[k0]; delete was[k0]; }
      }
    }
    const spare = Object.entries(was).filter(([k]) => !k.startsWith('moved:'));
    const take = (k, code) => {
      if (was['moved:' + k] && cardOf[was['moved:' + k]] === code) { const u = was['moved:' + k]; delete was['moved:' + k]; return u; }
      if (was[k] && cardOf[was[k]] === code) { const u = was[k]; delete was[k]; return u; }
      const i = spare.findIndex(([kk, u]) => cardOf[u] === code && was[kk] === u);
      if (i >= 0) { const [kk, u] = spare[i]; delete was[kk]; spare.splice(i, 1); return u; }
      const u = 'r' + (++uidN); cardOf[u] = code; return u;
    };
    const states = [0, 1].map(p => {
      const P = f[p], s = { cards: {}, zones: {}, flags: {}, lp: P.lp };
      for (const z of ['deck', 'hand', 'gy', 'banished', 'extra', 'mm1', 'mm2', 'mm3', 'mm4', 'mm5', 'emz1', 'emz2', 'st1', 'st2', 'st3', 'st4', 'st5', 'fz']) s.zones[z] = [];
      const put = (zone, loc, seq, c) => {
        if (!c) return;
        const k = `${p}:${loc}:${seq}`, u = take(k, c.code);
        next[k] = u;
        const i = info[c.code] || {};
        const own = i.token ? [i.atk, i.def] : cards[c.code] ? [cards[c.code][6], cards[c.code][7]] : null;
        s.cards[u] = i.token
          ? { id: '', name: i.name, token: true, frame: 'token', type: 'Token Monster', img: '', big: '', art: i.art, atk: i.atk, def: i.def, level: i.level, race: i.race, attribute: i.attribute }
          : { id: c.code, name: nm(c.code), img: img(c.code), big: big(c.code), frame: i.frame || '', type: i.type || '',
              extra: !!(c.type & EXTRA_TYPES), ...(c.type & T.MONSTER ? { atk: own ? own[0] : c.atk, def: own ? own[1] : c.def } : {}), ...look(p, c.code) };
        const down = (c.pos & 0xa) !== 0, def = loc === LOC.MZONE && (c.pos & 0xc) !== 0;
        s.flags[u] = { face: down || (loc === LOC.EXTRA && !(c.pos & 0x5)) ? 'down' : 'up', pos: def ? 'def' : 'atk' };
        // (a face-up monster's ATK / DEF as the engine has it now, when it isn't the card's own: shown changed)
        if (loc === LOC.MZONE && !down && own && (c.atk !== own[0] || c.def !== own[1])) s.flags[u].mods = { atk: c.atk, def: c.def };
        s.zones[zone].push(u);
      };
      P.hand.forEach((c, i) => put('hand', LOC.HAND, i, c && { ...c, pos: 1 }));
      P.mzone.forEach((c, i) => put(ZONE[LOC.MZONE](i), LOC.MZONE, i, c));
      P.szone.forEach((c, i) => { if (i < 6) put(ZONE[LOC.SZONE](i), LOC.SZONE, i, c); });
      // (piles: the top card first)
      P.grave.slice().reverse().forEach((c, j) => put('gy', LOC.GRAVE, P.grave.length - 1 - j, c && { ...c, pos: 1 }));
      P.removed.slice().reverse().forEach((c, j) => put('banished', LOC.REMOVED, P.removed.length - 1 - j, c));
      // (the Extra Deck: its face-up cards — a Pendulum Monster sent there — on top, shown face up and counted on the pile)
      const up = c => !!c && (c.pos & 0x5) !== 0;
      [...P.extra.map((c, i) => [c, i]).filter(([c]) => up(c)), ...P.extra.map((c, i) => [c, i]).filter(([c]) => !up(c))]
        .forEach(([c, i]) => { put('extra', LOC.EXTRA, i, c); if (up(c)) { const u = s.zones.extra[s.zones.extra.length - 1]; s.flags[u].faceUpExtra = true; } });
      for (let i = 0; i < P.deck; i++) { const u = `deck${p}_${i}`; s.cards[u] = { id: '', name: '', img: '' }; s.flags[u] = { face: 'down', pos: 'atk' }; s.zones.deck.push(u); }
      return s;
    });
    // the Extra Monster Zones are one row both players share: the opponent's monsters there drawn in your
    // board's (their left one — engine zone 5 — is the one on your right)
    const [mine, theirs] = states;
    oppEmz.clear();
    for (const [from, to] of [['emz1', 'emz2'], ['emz2', 'emz1']]) {
      for (const u of theirs.zones[from]) { mine.cards[u] = theirs.cards[u]; mine.flags[u] = theirs.flags[u]; mine.zones[to].push(u); oppEmz.add(u); }
      theirs.zones[from] = [];
    }
    at = next;
    return states;
  }
  const oppEmz = new Set();            // (the opponent's monsters in the shared Extra Monster Zones: drawn in your board)
  // after a render: those turned to face their owner, as the rest of the opponent's cards are; and each Extra
  // Monster Zone marked whose it is once one is taken (a player can use one of the two: the other is the opponent's)
  function markEmz(mine) {
    const b = o.boards.mine, zs = ['emz1', 'emz2'];
    for (const u of oppEmz) if (b.cardEl[u]) b.cardEl[u].classList.add('rd-opp');
    const yours = zs.map(z => mine.zones[z].some(u => !oppEmz.has(u))), its = zs.map(z => mine.zones[z].some(u => oppEmz.has(u)));
    zs.forEach((z, i) => {
      const el = b.zoneEl[z];
      if (!el) return;
      const free = !yours[i] && !its[i];
      el.classList.toggle('rd-emz-bot', free && yours.some(Boolean));
      el.classList.toggle('rd-emz-you', free && its.some(Boolean) && !yours.some(Boolean));
    });
  }
  // a card the engine names by place → its uid on the board
  const uidAt = (p, loc, seq) => at[`${p}:${loc}:${seq}`];

  // ── what happened, in words ──────────────────────────────────────────────────────────────
  const fx = { lit: null, lp: [0, 0] };
  let curPhase = '', askedIn = '', afterExtra = false;          // the phase now (turn:phase), and the one a card of yours on the field was last offered in
  let chain = [], lastActor = -1;          // the chain open (links: {n, code, controller, location, sequence}); who last made a move
  let targeted = [];                        // the cards the chain's effects target ("p:loc:seq"), marked till it's over
  const plays = [];                         // this update's plays, for the board: {kind, code, controller, location, sequence}
  // a play shown on the table as it happens (the bot's, and what happens to your cards): o.ui.play({code, text, side})
  const play = (side, code, text) => o.ui.play && o.ui.play({ side, code, text, img: code ? img(code) : '' });
  const ZN = { [LOC.HAND]: 'hand', [LOC.MZONE]: 'field', [LOC.SZONE]: 'field', [LOC.GRAVE]: 'GY', [LOC.REMOVED]: 'banished', [LOC.DECK]: 'Deck', [LOC.EXTRA]: 'Extra Deck' };
  const whose = p => p === 0 ? 'Your' : '';           // (the bot's own: its line already says Bot)
  // (a card on the field by its place, from the field as it was: an attacker, its target)
  const codeAt = l => { const P = field && field[l.controller]; const z = P && (l.location === LOC.MZONE ? P.mzone : l.location === LOC.SZONE ? P.szone : null); return (z && z[l.sequence] && z[l.sequence].code) || 0; };
  function caption(m) {
    switch (m.type) {
      case 60: if (m.controller === 1) play(1, m.code, `Normal Summons <b>${esc(nm(m.code))}</b>`); break;
      case 62: if (m.controller === 1) play(1, m.code, `Special Summons <b>${esc(nm(m.code))}</b>`); break;
      case 64: if (m.controller === 1) play(1, m.code, `Flip Summons <b>${esc(nm(m.code))}</b>`); break;
      case 54: if (m.controller === 1) play(1, 0, 'Sets a card'); break;
      case 70: if (m.controller === 1) { const t = effectText(m.description); play(1, m.code, `Activates <b>${esc(nm(m.code))}</b>${t ? `<small>${esc(t)}</small>` : ''}`); } break;
      case 110: {
        if (m.card.controller !== 1) break;
        const a = codeAt(m.card), d = m.target && codeAt(m.target);
        play(1, a, `<b>${esc(nm(a))}</b> attacks ${m.target ? `your <b>${esc(d ? nm(d) : 'monster')}</b>` : '<b>you directly</b>'}`);
        break;
      }
      case 91: if (m.player === 0) play(0, 0, `You take <b>${m.amount}</b> damage`); else if (turnPlayer === 1) play(1, 0, `Bot takes <b>${m.amount}</b> damage`); break;
      case 50: {   // a card moving: the bot's searches and costs, and anything leaving the field
        const f = m.from || {}, t = m.to || {}, code = m.card;
        const fromField = f.location === LOC.MZONE || f.location === LOC.SZONE;
        if (f.location === LOC.DECK && t.location === LOC.HAND && t.controller === 1) play(1, code, `Adds <b>${esc(code ? nm(code) : 'a card')}</b> to its hand`);
        else if (f.location === LOC.HAND && f.controller === 1 && (t.location === LOC.GRAVE || t.location === LOC.REMOVED)) play(1, code, `Sends <b>${esc(nm(code))}</b> from its hand to the ${ZN[t.location]}`);
        else if (f.location === LOC.DECK && f.controller === 1 && (t.location === LOC.GRAVE || t.location === LOC.REMOVED)) play(1, code, `Sends <b>${esc(nm(code))}</b> from its Deck to the ${ZN[t.location]}`);
        else if (fromField && (t.location === LOC.GRAVE || t.location === LOC.REMOVED || t.location === LOC.HAND || t.location === LOC.DECK || t.location === LOC.EXTRA) && code && (f.controller === 0 || turnPlayer === 1))
          play(f.controller, code, `${whose(f.controller)}${whose(f.controller) ? " " : ""}<b>${esc(nm(code))}</b> ${t.location === LOC.GRAVE ? 'is sent to the GY' : t.location === LOC.REMOVED ? 'is banished' : t.location === LOC.HAND ? 'returns to the hand' : 'returns to the Deck'}`);
        break;
      }
    }
  }
  // what it sounds like (the page plays it, if it has sounds: o.ui.sound(name)) — a monster leaving the field in battle
  // is destroyed, otherwise it's an airy swish to the GY
  let battle = false;
  const sound = n => o.ui.sound && o.ui.sound(n);
  function hear(m) {
    switch (m.type) {
      case 40: battle = false; if (m.player === 0) sound('turn'); break;
      case 41: battle = false; break;
      case 60: case 64: sound('summon'); break;
      case 62: { const ty = (cards[m.code] || [])[2] || 0; sound(ty & (0x40 | 0x80 | 0x2000 | 0x800000 | 0x4000000) ? 'xsummon' : 'summon'); break; }
      case 54: sound('set'); break;
      case 70: sound('activate'); break;
      case 74: if (chain.length > 1) sound('resolve'); break;
      case 110: battle = true; sound('attack'); break;
      case 90: sound('draw'); break;
      case 91: sound('hit'); sound('lp'); break;
      case 100: sound('lp'); break;
      case 92: sound('gain'); break;
      case 32: sound('shuffle'); break;
      case 5: sound(m.player === 0 ? 'win' : 'lose'); break;
      case 50: {
        const f = m.from || {}, t = m.to || {};
        if ((f.location === LOC.MZONE || f.location === LOC.SZONE) && (t.location === LOC.GRAVE || t.location === LOC.REMOVED))
          sound(battle && f.location === LOC.MZONE ? 'destroy' : 'gy');
        break;
      }
    }
  }
  function tell(m) {
    const by = p => `<b>${esc(who(p))}</b>`;
    caption(m);
    hear(m);
    if (m.type === 2 && m.hint_type === 3 && m.player === 0) selHint = m.hint;
    if ([60, 62, 64, 70].includes(m.type)) lastActor = m.controller;
    // (your own Link / Fusion / Synchro / Xyz Summon: the window after it offered — Ars Magna's kind answers either's)
    if (m.type === 62 && m.controller === 0 && ((cards[m.code] || [])[2] & EXTRA_TYPES)) afterExtra = true;
    if (m.type === 41) afterExtra = false;
    if (m.type === 110) lastActor = m.card.controller;
    switch (m.type) {
      case 40: turnPlayer = m.player; lastActor = -1; o.ui.log(`<div class="t">Turn ${m.turnNo || ''} — ${esc(who(m.player))}</div>`);
        o.ui.banner && o.ui.banner(m.player === 0 ? 'Your turn' : 'The bot’s turn', m.player); break;
      case 41: curPhase = `${turns}:${m.phase}`; o.ui.phase({ player: turnPlayer, who: who(turnPlayer), phase: m.phase, name: PHASES[m.phase] || '', turn: turns }); break;
      case 60: o.ui.log(`${by(m.controller)} Normal Summoned ${esc(nm(m.code))}`); plays.push({ kind: 'normal', ...m }); break;
      case 62: o.ui.log(`${by(m.controller)} Special Summoned ${esc(nm(m.code))}`); plays.push({ kind: 'special', ...m }); break;
      case 64: o.ui.log(`${by(m.controller)} Flip Summoned ${esc(nm(m.code))}`); break;
      case 54: o.ui.log(`${by(m.controller)} Set a card`); break;
      case 70:
        o.ui.log(`${by(m.controller)} activated ${esc(nm(m.code))}${m.chain_size > 1 ? ` (Chain Link ${m.chain_size})` : ''}`);
        chain.push({ n: m.chain_size || chain.length + 1, code: m.code, controller: m.controller, location: m.location, sequence: m.sequence });
        plays.push({ kind: 'activate', ...m });
        // (the other side's activation: its card big for a moment with the effect it used, so you see what it played)
        if (m.controller === 1 && o.ui.flash) o.ui.flash({ code: m.code, name: nm(m.code), big: big(m.code), link: chain.length, text: effectText(m.description) || '' });
        break;
      case 31: {   // cards shown to you (CONFIRM_CARDS) — the other player's: shown big, each named in the log
        const theirs = (m.cards || []).filter(c => c.controller !== m.player && c.code);
        if (m.player !== 0 || !theirs.length) break;
        o.ui.log(`Shown to you — ${by(1)}’s ${theirs.map(c => esc(nm(c.code))).join(', ')}`);
        if (o.ui.flash) o.ui.flash({ code: theirs[0].code, name: nm(theirs[0].code), big: big(theirs[0].code), label: theirs.length > 1 ? `Revealed · ${theirs.length} cards` : 'Revealed' });
        break;
      }
      case 73: o.ui.log(`<span class="sys">The chain resolves</span>`); break;
      case 74: chain = []; targeted = []; break;
      case 83: for (const c of m.cards || []) targeted.push(`${c.controller}:${c.location}:${c.sequence}`); break;   // (BECOME_TARGET)
      case 110: o.ui.log(`${by(m.card.controller)} attacked${m.target ? '' : ' directly'}`); break;
      case 90: if (m.player === 0) o.ui.log(`You drew ${m.drawn.map(d => esc(nm(d.code))).join(', ')}`); else o.ui.log(`${by(1)} drew ${m.drawn.length}`); break;
      case 91: o.ui.log(`${by(m.player)} took ${m.amount} damage`); fx.lp[m.player] -= m.amount; break;
      case 92: o.ui.log(`${by(m.player)} gained ${m.amount} LP`); fx.lp[m.player] += m.amount; break;
      case 100: o.ui.log(`${by(m.player)} paid ${m.amount} LP`); fx.lp[m.player] -= m.amount; break;
      case 5: over = true; winner = m.player; o.ui.log(`<div class="t">${m.player === 0 ? 'You win!' : esc(o.bot.name) + ' wins.'}</div>`); break;
      case 1: o.ui.log('<span class="sys">The engine refused that — choose again.</span>'); break;
    }
  }

  // ── your prompts ─────────────────────────────────────────────────────────────────────────
  // an effect's description (the card's code and which of its texts): its text, as EDOPro shows it on its button —
  // effectText() the text alone (or ''), desc() with the card's name when there's no text; a description with no
  // code is one of EDOPro's own texts, by number (sysText: a choice's "Add the card(s) to your hand")
  const sysText = (i, code, where) => { let k = 0; return (sys[i] || '').replace(/%ls/g, () => (k++ ? where || 'the field' : code ? nm(code) : 'a card')).replace(/%d\s*/g, ''); };
  const PLACE = { [LOC.HAND]: 'your hand', [LOC.MZONE]: 'the Monster Zone', [LOC.SZONE]: 'the Spell & Trap Zone', [LOC.GRAVE]: 'the GY', [LOC.REMOVED]: 'banishment', [LOC.DECK]: 'the Deck', [LOC.EXTRA]: 'the Extra Deck' };
  // (a card's effect texts, as its database has them — what a trigger asked about with no text of its own can be)
  // (an option's or a prompt's own words — "Special Summon it", "Select the card…" — left out: they aren't effects)
  const textsOf = code => ((strs[code] || []).filter(t => t && t.length >= 28 && !/^Select |^Choose |\?$/.test(t))).slice(0, 4);
  const effectText = d => {
    d = BigInt(d || 0); const c = Number(d >> 20n), i = Number(d & 0xfffffn);
    return c ? ((strs[c] || [])[i] || '') : '';
  };
  const desc = (d, code) => {
    d = BigInt(d || 0); const c = Number(d >> 20n), i = Number(d & 0xfffffn);
    if (!c) return (i && sysText(i, code)) || (code ? nm(code) : `Option ${i + 1}`);
    return effectText(d) || `${nm(c)}${i ? ` — effect ${i + 1}` : ''}`;
  };
  // what the next choice of cards is for, as the script says it (a hint, HINT_SELECTMSG: "Select the card(s) to add
  // to your hand"): the prompt's title, how many in its line — else "Choose 2"
  let selHint = null;
  const howMany = m => m.min === m.max ? m.min : `${m.min}–${m.max}`;
  const hintText = () => (selHint ? effectText(selHint) || (Number(BigInt(selHint) >> 20n) ? '' : sysText(Number(BigInt(selHint) & 0xfffffn))) : '');
  const pickTitle = (m, verb = 'Choose') => hintText() || `${verb} ${howMany(m)}`;
  const pickCount = (m, more = '') => (hintText() ? `Choose ${howMany(m)}${more ? ' — ' + more : '.'}` : more);
  let targeting = null;
  const reply = r => {
    ask = null; placing = null; paintPlaces(); selHint = null;
    if (targeting) { for (const d of document.querySelectorAll('.rd-target, .rd-picked')) d.classList.remove('rd-target', 'rd-picked'); targeting = null; }
    o.ui.prompt(null); highlight([]);
    if (o.onAnswer) o.onAnswer(r);
    if (o.online) o.online.send(sides(r)); else worker.postMessage({ t: 'answer', r });
  };
  // a zone to pick: the ones you can, lit on the field (the Extra Monster Zones are in your board's row: theirs
  // too, their left being your right)
  let placing = null;
  function placeEl(pl) {
    if (pl.location === LOC.MZONE && pl.sequence >= 5) return o.boards.mine.zoneEl[(pl.player === 0 ? ['emz1', 'emz2'] : ['emz2', 'emz1'])[pl.sequence - 5]];
    return (pl.player === 0 ? o.boards.mine : o.boards.theirs).zoneEl[ZONE[pl.location](pl.sequence)];
  }
  function paintPlaces() {
    for (const b of [o.boards.mine, o.boards.theirs]) for (const z of b.el.querySelectorAll('.zone.rd-place')) { z.classList.remove('rd-place'); delete z.dataset.place; }
    if (!placing) return;
    placing.places.forEach((pl, i) => {
      if (placing.chosen.includes(pl)) return;
      const z = placeEl(pl);
      if (z) { z.classList.add('rd-place'); z.dataset.place = i; }
    });
  }
  // the actions open on each card (main / battle): uid → [{label, r}]
  let onCard = {};
  // the cards you can use now lit — and a pile (Extra Deck, GY, banished) with one in it, lit too: it opens
  const PILE_ZONES = ['extra', 'gy', 'banished'];
  let last = { mine: null, theirs: null };
  function highlight(uids) {
    for (const [k, b] of Object.entries(o.boards)) {
      for (const d of b.el.querySelectorAll('.card')) d.classList.toggle('rd-can', uids.includes(d.dataset.uid));
      for (const z of PILE_ZONES) {
        const el = b.el.querySelector(`[data-zone="${z}"]`);
        if (!el) continue;
        const lit = !!last[k] && (last[k].zones[z] || []).some(u => uids.includes(u));
        el.classList.toggle('rd-can-pile', lit);
        // (your Extra Deck with a summon in it: a tag on it saying so)
        let tag = el.querySelector(':scope > .rd-pile-tag');
        if (lit && z === 'extra' && k === 'mine') { if (!tag) { tag = document.createElement('i'); tag.className = 'rd-pile-tag'; tag.textContent = 'Summon'; el.appendChild(tag); } }
        else if (tag) tag.remove();
      }
    }
  }
  function promptFor(m) {
    onCard = {};
    const add = (c, label, r) => { const u = uidAt(c.controller, c.location, c.sequence); if (u) (onCard[u] = onCard[u] || []).push({ label, r }); };
    const P = { title: '', text: '', buttons: [], cards: null };
    switch (m.type) {
      case 11:
        P.mode = 'move'; P.title = 'Your move';
        P.text = m.summons.length + m.special_summons.length + m.activates.length + m.spell_sets.length + m.monster_sets.length + m.pos_changes.length
          ? 'Tap a lit card for what it can do.' : 'Nothing to play — move on when you’re ready.';
        m.summons.forEach((c, i) => add(c, 'Normal Summon', { type: 1, action: 0, index: i }));
        m.special_summons.forEach((c, i) => add(c, 'Special Summon', { type: 1, action: 1, index: i }));
        m.monster_sets.forEach((c, i) => add(c, 'Set', { type: 1, action: 3, index: i }));
        m.spell_sets.forEach((c, i) => add(c, 'Set', { type: 1, action: 4, index: i }));
        m.activates.forEach((c, i) => {
          const several = m.activates.filter(x => x.code === c.code && x.sequence === c.sequence && x.location === c.location).length > 1;
          add(c, `Activate${several || effectText(c.description) ? ' — ' + (effectText(c.description) || desc(c.description, c.code)) : ''}`, { type: 1, action: 5, index: i });
        });
        m.pos_changes.forEach((c, i) => add(c, 'Change position', { type: 1, action: 2, index: i }));
        P.phases = { ...(m.to_bp && { bp: { type: 1, action: 6, index: null } }), ...(m.to_ep && { ep: { type: 1, action: 7, index: null } }) };
        break;
      case 10:
        P.mode = 'move'; P.title = 'Battle';
        P.text = m.attacks.length ? 'Tap a lit monster to attack with it.' : 'Nothing can attack.';
        m.attacks.forEach((c, i) => add(c, c.can_direct ? 'Attack directly' : 'Attack', { type: 0, action: 1, index: i }));
        m.chains.forEach((c, i) => add(c, 'Activate', { type: 0, action: 0, index: i }));
        P.phases = { ...(m.to_m2 && { m2: { type: 0, action: 2, index: null } }), ...(m.to_ep && { ep: { type: 0, action: 3, index: null } }) };
        break;
      case 16: {
        const mode = (o.chainMode && o.chainMode()) || 'auto';
        // (Auto: asked when they've just moved or a trigger of yours can — and, in each phase of their turn, once
        //  when a card of yours on the field can be used: a Set Infinite Impermanence in their Standby Phase)
        // (and the window right after your own summon from the Extra Deck — once)
        const fieldCard = turnPlayer === 1 && askedIn !== curPhase && m.selects.some(c => c.location & (LOC.MZONE | LOC.SZONE));
        const extraWin = afterExtra;
        afterExtra = false;
        if (!m.forced && (mode === 'never' || (mode === 'auto' && lastActor !== 1 && !m.spe_count && !fieldCard && !extraWin))) { reply({ type: 8, index: null }); return; }
        if (fieldCard) askedIn = curPhase;
        P.mode = 'chain'; P.title = m.forced ? 'You must activate' : 'Respond?';
        P.text = m.forced ? '' : 'You can chain one of these now.';
        P.cards = m.selects.map((c, i) => ({ code: c.code, label: nm(c.code), sub: effectText(c.description), r: { type: 8, index: i } }));
        if (!m.forced) P.buttons.push({ label: 'No', r: { type: 8, index: null }, go: true });
        break;
      }
      case 12: {
        const own = effectText(m.description), codeless = !Number(BigInt(m.description || 0) >> 20n), list = own ? [] : textsOf(m.code);
        P.title = `Use the effect of ${nm(m.code)}?`;
        // (the engine's own wording — "Activate the Trigger Effect of … from […]?" — names no effect: said plainly, the card's effects under it)
        P.text = own || (codeless && list.length ? `Its trigger effect, from ${PLACE[m.location] || 'the field'}${list.length > 1 ? ' — its effects:' : ':'}` : '');
        P.cards = [{ code: m.code, label: nm(m.code), sub: own || (list.length === 1 ? list[0] : list.length ? list.map((t, i) => `${i + 1}. ${t}`).join('\n') : '') }];
      }
        P.buttons.push({ label: 'Yes', r: { type: 2, yes: true }, go: true }, { label: 'No', r: { type: 2, yes: false } }); break;
      case 13: P.title = desc(m.description).replace(/\??$/, '?'); P.buttons.push({ label: 'Yes', r: { type: 3, yes: true }, go: true }, { label: 'No', r: { type: 3, yes: false } }); break;
      case 14: {
        // (the card whose texts they are: any option's — one may be EDOPro's own, "Add the card(s) to your hand")
        const codes = m.options.map(d => Number(BigInt(d || 0) >> 20n)), from = codes.find(Boolean);
        P.title = from ? `${nm(from)}: choose ${codes.every(Boolean) ? 'an effect' : 'one'}` : 'Choose one';
        if (from) P.cards = [{ code: from, label: nm(from) }];
        m.options.forEach((d, i) => P.buttons.push({ label: desc(d), r: { type: 4, index: i } }));
        break;
      }
      case 19: P.title = `${nm(m.code)}: which position?`; P.cards = [{ code: m.code, label: nm(m.code) }]; P.positions = true;   // (shown as the card in each position — rules-ui.js)
        [[1, 'Attack'], [4, 'Defense'], [8, 'Set (face-down Defense)'], [2, 'Face-down Attack']].forEach(([v, t]) => { if (m.positions & v) P.buttons.push({ label: t, r: { type: 11, position: v } }); });
        break;
      case 15: case 20: return pick(m, m.type === 20);
      case 26: {   // cards picked one at a time (Fusion, Synchro, Link materials…): those picked so far (unselect_cards:
        // tapped again, taken back — the answer's index counts on past select_cards) and those you can still pick;
        // Done once enough are, Cancel (the summon, the effect) while the engine allows it — mostly with none picked
        const picked = m.unselect_cards || [], who = c => (c.controller ? o.bot.name + '’s ' : '') + nm(c.code);
        const last = picked.length + 1 >= m.max;               // (the next pick would complete it: held till you Confirm)
        let held = -1;
        const paint26 = () => {
          const Q = { mode: 'pick', list: true, title: pickTitle(m), buttons: [],
            text: pickCount(m, picked.length || held >= 0 ? `${picked.length + (held >= 0 ? 1 : 0)} chosen — tap one again to take it back.` : '') };
          Q.cards = [...picked.map((c, j) => ({ code: c.code, label: who(c), sub: 'Chosen — tap to take back', on: true, r: { type: 7, index: m.select_cards.length + j } })),
                     ...m.select_cards.map((c, i) => ({ code: c.code, label: who(c), on: i === held, sub: i === held ? 'Chosen — tap to take back' : '', toggle: last ? i : undefined, r: last ? undefined : { type: 7, index: i } }))];
          if (held >= 0) Q.buttons.push({ label: 'Confirm', r: { type: 7, index: held }, go: true });
          // (no answer means Done when it can finish, else Cancel)
          else if (m.can_finish) Q.buttons.push({ label: 'Done', r: { type: 7, index: null }, go: true });
          if (held < 0 && !m.can_finish && m.can_cancel) Q.buttons.push({ label: 'Cancel', r: { type: 7, index: null } });
          o.ui.prompt(Q, r => { if (r && r.toggle !== undefined) { held = held === r.toggle ? -1 : r.toggle; paint26(); return; } reply(r); });
        };
        highlight([]);
        paint26();
        return;
      }
      case 142: {   // a card's name, declared: one the card's filter accepts (m.opcodes) — the handful listed, many found by name
        const ok = declarable(m.opcodes), all = Object.keys(cards).map(Number).filter(ok), few = all.length <= 120, set = new Set(all);
        const item = (code, label) => ({ code, label, r: { type: 18, card: code } });
        P.title = hintText() || 'Declare a card name';
        P.text = `${all.length} card name${all.length === 1 ? '' : 's'} can be declared${few ? '' : ' — search for one'}.`;
        P.list = true; P.cards = [];
        P.search = async q => {
          q = q.trim().toLowerCase();
          if (few) { const list = await named(all); return q ? list.filter(c => c.label.toLowerCase().includes(q)) : list; }
          if (q.length < 2) return [];
          const hits = await fetch('/card-search?q=' + encodeURIComponent(q)).then(r => r.json()).catch(() => []);
          return hits.filter(h => set.has(+h.id)).slice(0, 40).map(h => item(+h.id, h.name));
        };
        const named = async codes => {
          const want = codes.filter(c => !(info[c] || {}).name && !(known[c] || {}).name);
          for (let k = 0; k < want.length; k += 150) Object.assign(known, await fetch('/deck-cards?ids=' + want.slice(k, k + 150).join(',')).then(r => r.json()).catch(() => ({})));
          return codes.map(c => item(c, (info[c] || {}).name || (known[c] || {}).name || `Card ${c}`)).sort((a, b) => a.label.localeCompare(b.label));
        };
        P.search('').then(list => { P.cards = list; highlight([]); o.ui.prompt(P, reply); });
        return;
      }
      case 18: case 24: {   // a zone: where a card goes (18), or one to choose for an effect (24) — tapped on the field
        // (field_mask: a bit set is a zone you can't pick; the low 16 bits yours — Monster Zones 0–6, Spell & Trap
        // Zones 8–13 — the high 16 the opponent's)
        const places = [];
        for (const side of [0, 1]) for (const [loc, base, n] of [[LOC.MZONE, 0, 7], [LOC.SZONE, 8, 6]]) for (let q = 0; q < n; q++) {
          if (!((m.field_mask >>> ((side ? 16 : 0) + base + q)) & 1)) places.push({ player: side ? 1 - m.player : m.player, location: loc, sequence: q });
        }
        const kind = m.type === 18 ? 10 : 9;
        if (places.length <= m.count) { reply({ type: kind, places }); return; }   // (no choice to make)
        placing = { m, kind, places, chosen: [] };
        P.mode = 'place';
        P.title = m.type === 18 ? 'Where does it go?' : 'Choose a zone';
        P.text = `Tap a lit zone on the field${m.count > 1 ? ` — ${m.count} of them` : ''}.`;
        o.ui.prompt(P, reply);
        paintPlaces();
        return;
      }
      case 140: case 141: {   // a Type (ANNOUNCE_RACE) or an Attribute (ANNOUNCE_ATTRIB) — m.count of them, from m.available
        const race = m.type === 140, names = race ? RACES : ATTRS, avail = BigInt(m.available || 0), chosen = [];
        const opts = names.map((n, i) => [n, 1n << BigInt(i)]).filter(([, bit]) => avail & bit);
        const paintA = () => o.ui.prompt({ mode: 'ask', title: hintText() || (race ? 'Declare a Type' : 'Declare an Attribute'),
          text: m.count > 1 ? `Choose ${m.count} — ${chosen.length} chosen` : '',
          buttons: [...opts.map(([n, bit]) => ({ label: (chosen.includes(bit) ? '✓ ' : '') + n, r: { pick: bit } })),
                    ...(m.count > 1 ? [{ label: 'Confirm', r: { done: true }, go: true, off: chosen.length !== m.count }] : [])] },
          r => {
            if (r.pick !== undefined) { const i = chosen.indexOf(r.pick); if (i >= 0) chosen.splice(i, 1); else if (chosen.length < m.count) chosen.push(r.pick); if (m.count > 1) { paintA(); return; } }
            if (chosen.length !== m.count) { paintA(); return; }
            reply(race ? { type: 16, races: chosen.map(String) } : { type: 17, attributes: chosen.map(Number) });
          });
        paintA();
        return;
      }
      case 132:     // rock-paper-scissors
        P.title = 'Rock, paper, scissors';
        ['Scissors', 'Rock', 'Paper'].forEach((n, i) => P.buttons.push({ label: n, r: { type: 20, value: i + 1 } }));
        break;
      case 143:     // a number (ANNOUNCE_NUMBER): one of m.options
        P.title = hintText() || 'Declare a number';
        m.options.forEach((v, i) => P.buttons.push({ label: String(Number(BigInt(v) & 0xffffffffn)), r: { type: 19, value: i } }));
        break;
      default: {   // (a sum, counters, an order: chosen for you for now)
        import('./bot.js').then(({ decide }) => reply(decide(m, { lib: null, handle: null, cards: {}, turn: 0, phase: '', level: 'normal' }))).catch(() => {});
        return;
      }
    }
    highlight(Object.keys(onCard));
    o.ui.prompt(P, reply);
  }
  // a declaration's filter: its opcodes (constant.lua's OPCODE_*) run as a stack, as EDOPro's own client does →
  // code → whether that card's name can be declared
  const known = {};                         // (names fetched for a declaration: /deck-cards)
  function declarable(opcodes) {
    const ops = (opcodes || []).map(x => BigInt(x)), O = k => 0x4000000000000000n + (BigInt(k) << 32n);
    const [ADD, SUB, MUL, DIV, AND, OR, NEG, NOT, BAND, BOR] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(O);
    const [BNOT, BXOR, LSHIFT, RSHIFT, ALIASES, TOKENS] = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15].map(O);
    const [ISCODE, ISSETCARD, ISTYPE, ISRACE, ISATTRIBUTE, GETCODE, GETSETCARD, GETTYPE, GETRACE, GETATTRIBUTE] = [0x100, 0x101, 0x102, 0x103, 0x104, 0x105, 0x106, 0x107, 0x108, 0x109].map(O);
    const B = v => (v ? 1n : 0n);
    return code => {
      const c = cards[code];
      if (!c) return false;
      const [alias, sets, type, , attr, race] = c, st = [];
      let aliases = false, tokens = false;
      const two = f => { if (st.length >= 2) { const r = st.pop(), l = st.pop(); st.push(f(l, r)); } };
      const one = f => { if (st.length) st.push(f(st.pop())); };
      for (const op of ops) {
        switch (op) {
          case ADD: two((l, r) => l + r); break; case SUB: two((l, r) => l - r); break; case MUL: two((l, r) => l * r); break;
          case DIV: two((l, r) => (r ? l / r : l)); break; case AND: two((l, r) => B(l && r)); break; case OR: two((l, r) => B(l || r)); break;
          case NEG: one(v => -v); break; case NOT: one(v => B(!v)); break; case BAND: two((l, r) => l & r); break; case BOR: two((l, r) => l | r); break;
          case BNOT: one(v => ~v); break; case BXOR: two((l, r) => l ^ r); break; case LSHIFT: two((l, r) => l << r); break; case RSHIFT: two((l, r) => l >> r); break;
          case ALIASES: aliases = true; break; case TOKENS: tokens = true; break;
          case ISCODE: one(v => B(BigInt(code) === v)); break;
          case ISSETCARD: one(v => B((sets || []).some(x => (BigInt(x) & 0xfffn) === (v & 0xfffn) && (BigInt(x) & v) === v))); break;
          case ISTYPE: one(v => B(BigInt(type) & v)); break; case ISRACE: one(v => B(BigInt(race) & v)); break; case ISATTRIBUTE: one(v => B(BigInt(attr) & v)); break;
          case GETCODE: st.push(BigInt(code)); break; case GETSETCARD: st.push(BigInt((sets || [])[0] || 0)); break; case GETTYPE: st.push(BigInt(type)); break;
          case GETRACE: st.push(BigInt(race)); break; case GETATTRIBUTE: st.push(BigInt(attr)); break;
          default: st.push(op);
        }
      }
      if (st.length !== 1 || st[0] === 0n) return false;
      // (an alternate artwork: only when it says so; a Token neither — but Marine Dolphin and Twinkle Moss, which are their own cards)
      return code === 78734254 || code === 13857930 || ((aliases || !alias) && (tokens || (type & 0x4001) !== 0x4001));
    };
  }
  // cards to choose (targets, costs, Tributes, materials): a sheet of them, as many as it takes
  function pick(m, tribute) {
    const picked = [];
    const onBoard = m.selects.map(c => uidAt(c.controller, c.location, c.sequence));
    if (onBoard.every(Boolean) && m.selects.every(c => c.location === LOC.MZONE || c.location === LOC.SZONE || (c.location === LOC.HAND && c.controller === 0))) {
      targeting = { m, picked, onBoard, tribute };
      const paintT = () => {
        for (const b of [o.boards.mine, o.boards.theirs]) for (const d of b.el.querySelectorAll('.card')) {
          const i = onBoard.indexOf(d.dataset.uid);
          d.classList.toggle('rd-target', i >= 0 && !picked.includes(i));
          d.classList.toggle('rd-picked', i >= 0 && picked.includes(i));
        }
        const done = picked.length >= m.min;
        o.ui.prompt({ mode: 'target', title: pickTitle(m, tribute ? 'Tribute' : 'Choose'),
          text: pickCount(m, `tap ${m.max === 1 ? 'a lit card' : 'the lit cards'} on the field${picked.length ? ` — ${picked.length} chosen` : ''}.`).replace(/^t/, 'T'),
          buttons: [...(m.max > 1 || m.min > 1 ? [{ label: 'Confirm', r: { type: tribute ? 12 : 5, indicies: picked }, go: true, off: !done }] : []),
                    ...(m.can_cancel ? [{ label: 'Cancel', r: { type: tribute ? 12 : 5, indicies: null } }] : [])] }, reply);
      };
      targeting.paint = paintT;
      paintT();
      return;
    }
    const paint = () => o.ui.prompt({
      mode: 'pick', title: pickTitle(m, tribute ? 'Tribute' : 'Choose'),
      text: pickCount(m, picked.length ? `${picked.length} chosen` : ''),
      cards: m.selects.map((c, i) => ({ code: c.code, label: (c.controller ? o.bot.name + '’s ' : '') + nm(c.code), on: picked.includes(i), toggle: i })),
      buttons: [{ label: 'Confirm', r: { type: tribute ? 12 : 5, indicies: picked }, go: true, off: picked.length < m.min },
                ...(m.can_cancel ? [{ label: 'Cancel', r: { type: tribute ? 12 : 5, indicies: null } }] : [])],
    }, r => {
      if (r && r.toggle !== undefined) { const i = picked.indexOf(r.toggle); if (i >= 0) picked.splice(i, 1); else if (picked.length < m.max) picked.push(r.toggle); paint(); return; }
      reply(r);
    });
    paint();
  }
  // a tap on the board: a lit card's actions (one: done; several: a menu), else the card shown big
  const zoom = u => o.ui.zoom({ code: cardOf[u], name: nm(cardOf[u]), big: big(cardOf[u]) });
  // a tap on the board: a pile opens (its cards, and what each can do); a lit card, its menu (what it can do,
  // and See the card); any other card, shown big
  function tap(e) {
    // (a target: tapped on the field — one to choose: done; several: toggled, then Confirm)
    const tc = targeting && e.target.closest('.card.rd-target, .card.rd-picked');
    if (tc) {
      const T = targeting, i = T.onBoard.indexOf(tc.dataset.uid), at = T.picked.indexOf(i);
      if (at >= 0) T.picked.splice(at, 1); else if (T.picked.length < T.m.max) T.picked.push(i);
      if (T.m.max === 1 && T.picked.length === 1) { reply({ type: T.tribute ? 12 : 5, indicies: T.picked }); return; }
      T.paint();
      return;
    }
    const pz = placing && e.target.closest('.zone.rd-place');
    if (pz) {
      placing.chosen.push(placing.places[+pz.dataset.place]);
      if (placing.chosen.length >= placing.m.count) reply({ type: placing.kind, places: placing.chosen }); else paintPlaces();
      return;
    }
    const side = e.currentTarget === o.boards.mine.el ? 'mine' : 'theirs';
    const z = e.target.closest('[data-zone]'), zone = z && z.dataset.zone;
    if (PILE_ZONES.includes(zone)) { openPile(side, zone); return; }
    const d = e.target.closest('.card[data-uid]');
    if (!d) return;
    const u = d.dataset.uid, acts = onCard[u];
    if (acts && ask) {
      zoom(u);
      o.ui.menu(acts, d, reply);
      return;
    }
    if (cardOf[u] && !(d.classList.contains('down') && d.closest('.cboard') === o.boards.theirs.el)) zoom(u);
  }
  // a pile's cards in a sheet: yours face-up (your Extra Deck too), theirs face-up but for their Extra Deck
  function openPile(side, zone) {
    const s = last[side];
    if (!s) return;
    const uids = s.zones[zone] || [];
    const hidden = u => side === 'theirs' && zone === 'extra' && (s.flags[u] || {}).face === 'down';
    const name = { extra: 'Extra Deck', gy: 'GY', banished: 'banished cards' }[zone];
    o.ui.sheet({
      title: `${side === 'mine' ? 'Your' : o.bot.name + '’s'} ${name}`,
      text: uids.length ? (uids.some(u => onCard[u]) ? 'The lit cards can be used now — tap one.' : '') : 'Empty.',
      cards: uids.filter(u => !hidden(u)).map(u => ({ code: cardOf[u], label: nm(cardOf[u]), uid: u, acts: (ask && onCard[u]) || [] })),
      more: uids.filter(hidden).length ? `${uids.filter(hidden).length} face-down` : '',
    }, a => a.view ? zoom(a.view) : reply(a.r));
  }
  o.boards.mine.el.addEventListener('click', tap);
  o.boards.theirs.el.addEventListener('click', tap);

  worker.onmessage = e => {
    const d = e.data;
    if (d.t === 'error') { o.ui.log(`<span class="err">${esc(d.text.split('\n')[0])}</span>`); console.error(d.text); return; }
    if (d.t === 'log') { console.warn('[engine]', d.text); return; }
    if (d.t === 'replay') { o.onReplay && o.onReplay(d.answers); return; }
    if (d.t !== 'update') return;
    if (seat) { d.msgs = swapSides(d.msgs); d.ask = swapSides(d.ask); d.field = [d.field[1], d.field[0]]; }
    for (const m of d.msgs) { if (m.type === 40) m.turnNo = ++turns; tell(m); }
    field = d.field;
    if (o.debug) o.debug.field = field;
    const [mine, theirs] = reconcile(field, d.msgs);
    last = { mine, theirs };
    // (a card the engine names by code: its uid on a board — on the field first)
    const find = (st, code) => { const us = Object.keys(st.cards).filter(u => cardOf[u] === code); return us.find(u => !['deck', 'hand', 'gy', 'banished', 'extra'].some(z => st.zones[z].includes(u))) || us[0]; };
    const opt = [{ lpChange: fx.lp[0] || undefined }, { lpChange: fx.lp[1] || undefined }];
    const board = u => (mine.cards[u] ? 0 : 1);
    // (a card the engine names by its place — its own, on its player's board: the same card in the other player's
    //  hand isn't it — else by its code, its player's board first)
    const locate = l => {
      const u = uidAt(l.controller, l.location, l.sequence);
      if (u && cardOf[u] === l.code) return u;
      const [own, other] = l.controller === 1 ? [theirs, mine] : [mine, theirs];
      return find(own, l.code) || find(other, l.code);
    };
    for (const pl of plays) {
      const u = locate(pl);
      if (!u) continue;
      const o2 = opt[board(u)];
      if (pl.kind === 'activate') { o2.lit = u; o2.activate = true; continue; }
      const ty = (cards[pl.code] || [])[2] || 0;
      const extra = ty & 0x40 ? 'fusion' : ty & 0x2000 ? 'synchro' : ty & 0x800000 ? 'xyz' : ty & 0x4000000 ? 'link' : ty & 0x80 ? 'ritual' : '';
      if (pl.kind === 'special' && extra) { o2.lit = u; o2.summon = extra; }
      else (o2.fx = o2.fx || []).push({ uid: u, kind: pl.kind });
    }
    plays.length = 0;
    // (the chain open: a Chain Link badge on each card in it, its list on your board)
    if (chain.length) {
      const links = chain.map(l => ({ n: l.n, uid: locate(l), name: nm(l.code), opp: l.controller === 1 }));
      opt[0].chain = links; opt[1].chain = links; opt[1].chainNoList = true;
      opt[0].chainMin = opt[1].chainMin = 1;
    }
    o.boards.mine.render(mine, opt[0]);
    o.boards.theirs.render(theirs, opt[1]);
    markEmz(mine);
    for (const k of targeted) { const u = at[k]; for (const b of [o.boards.mine, o.boards.theirs]) if (u && b.cardEl[u]) b.cardEl[u].classList.add('rd-tgt'); }
    if (o.onUpdate) o.onUpdate(mine, theirs);           // (the boards as they are now: a page's own counts and plates)
    fx.lp = [0, 0];
    if (d.practiceOver) { over = true; o.ui.prompt(null); o.onPractice && o.onPractice(field); return; }
    if (over) { o.ui.prompt(null); o.onEnd && o.onEnd(winner === 0); return; }
    ask = d.ask;
    engineAsk = ask;
    if ((o.online || o.replay) && feed()) { ask = null; return; }   // (an answer already in: given, no prompt)
    if (ask && o.replay) { ask = null; o.ui.prompt({ mode: 'wait', title: 'The replay — its buttons below', text: '', buttons: [] }); if (o.onIdle) o.onIdle(); return; }
    if (ask && o.online && ask.player !== 0) { ask = null; o.ui.prompt({ mode: 'wait', title: `${o.bot.name} is thinking`, text: '', buttons: [] }); }
    else if (ask) promptFor(ask);
    else o.ui.prompt({ mode: 'wait', title: `${o.bot.name} is playing`, text: '', buttons: [] });
  };
  // (online: the answers in the room's order, each given when the engine waits for one)
  const pending = [];
  let engineAsk = null;
  // (one from the player the engine isn't asking: dropped — a browser answers only for its own side)
  function feed() {
    while (engineAsk && pending.length) {
      const { r, mine } = pending.shift();
      if ((engineAsk.player === 0) !== mine) { console.warn('[online] an answer out of turn, dropped'); continue; }
      engineAsk = null;
      worker.postMessage({ t: 'answer', r });
      return true;
    }
    return false;
  }
  worker.postMessage({ t: 'start', decks, board, hand: hand.length ? hand : null, lab: !!o.lab,
                       bots: o.bots || (o.online ? [false, false] : [false, true]), level: o.level, names, scripts: o.scripts || '/duel-scripts/',
                       speed: o.speed || 'normal', seed: o.seed || Math.floor(Math.random() * 2 ** 31) + 1 });
  return { stop: () => worker.terminate(), replay: () => worker.postMessage({ t: 'replay' }), speed: v => worker.postMessage({ t: 'speed', v }),
           apply: (r, mine) => { pending.push({ r, mine: !!mine }); feed(); } };
}
