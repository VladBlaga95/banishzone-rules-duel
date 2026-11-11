// BanishZone Rules Duel — the engine's side, in a Web Worker.
// Copyright (C) 2026 BanishZone. Licensed under the GNU Affero General Public License v3 or later (see LICENSE.md).
//
// Runs EDOPro's rules engine (ocgcore, via ocgcore-wasm) with Project Ignis' card scripts, and talks to the
// page in plain messages:
//   page → worker  {t: 'start', decks: [{main: [codes], extra: [codes]}, …], board?, bots: [false, true], level, seed, scripts,
//                   (board: an endboard for the bot's side — {cards: [{code, location, sequence, position}], lp}: you
//                    play your turn against it — you draw and may attack — and with no deck of its own, the practice
//                    ends as your turn does: {t: 'update', practiceOver: true})
//                   names: {code: name} (the bot reads its cards by name),
//                   hand?: [codes] your opening hand, in your hand from the start (taken out of your Deck by the page),
//                   handDraw?: with a hand given, the cards drawn on top of it (a puzzle's "and your draw": 1; else 0),
//                   lab?: the Combo Lab's Auto — no one across the field: the duel ends as your turn does, as a practice's,
//                   rules?: the duel's options, as a host sets them — {rules: '' (Master Rule 5) | 'mr4' | 'mr3' | 'mr2' | 'goat',
//                   lp, hand (cards drawn to start), draw (cards drawn each turn)},
//                   combos?: the bot's deck's combos, recorded in the Combo Lab's Auto — [{main, extra, hand, seed, answers}]:
//                   on its own turn (Normal, Hard) it plays their moves when it can — see "the bot's combos" below)
//                  {t: 'answer', r}           your answer to the prompt it last sent
//                  {t: 'speed', v}            how fast the bot's plays go: 'slow' | 'normal' | 'fast'
//   worker → page  {t: 'update', msgs, field, ask}   what happened (the engine's messages, simplified), the field
//                                                     as it is now, and the prompt waiting for you (or null)
//                  {t: 'error', text}
// A seat marked as a bot is answered here (bot.js), a moment apart so it can be watched.
// The duel is a seed and the answers given: `answers` is its replay.
import createCore, { OcgDuelMode, OcgProcessResult } from './vendor/ocgcore-wasm/index.js';
import { decide } from './bot.js';
import { lookahead } from './lookahead.js';

const ASK = new Set([10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 132, 140, 141, 142, 143]);
// code, position, ATK, DEF (not TYPE: with it ocgcore-wasm 0.1.6 reads a location's cards out of step — the type comes from cards.json)
const Q = 0x1 | 0x2 | 0x100 | 0x200;
const LOC = { DECK: 1, HAND: 2, MZONE: 4, SZONE: 8, GRAVE: 16, REMOVED: 32, EXTRA: 64 };
let lib, handle, cards = {}, base = '', bots = [false, false], ctx, lastAsk = null, over = false;
// the bot's plays one at a time: while it acts (from its answer to your next one), the engine is stepped and the
// page told after each step that shows something, a moment apart — how long, by what happened; speed: the page's
let botActive = false, speed = 1;
// (Normal: long enough to follow each play, its effect included — the board's animations take about 0.4–0.6 s;
//  Slow (×1.7) about the old pace, Fast ×0.4)
const STEP_MS = { 70: 620, 60: 540, 62: 540, 64: 540, 110: 500, 91: 420, 92: 420, 100: 360, 54: 360, 53: 300, 50: 280, 90: 200, 73: 180 };
const BEAT_MS = 220;
const answers = [];
// the duel as it began (its seed, the Decks in their shuffled order), to make copies of it: the bot's trials
let spec = null, choose = null, practiceOver = false;

// ── the bot's combos ────────────────────────────────────────────────────────────────────────────────────────────
// A combo recorded in the Combo Lab's Auto is a duel of its own: a deck, a hand, a seed and the answers given. Each
// is played again here, quietly, before the duel starts, to read what every answer chose — the card (by its code),
// the effect, the zone — so a combo becomes a line of choices: a move in the Main Phase ({t: 11, action, code, loc,
// desc}), then what that move asked ({t: 15, codes}, {t: 14, desc}, {t: 18, places}…), then the next move.
// On its own turn the bot follows them (follow): at each move, the first move of a line it hasn't made this turn
// and can make now (the line that fits its hand best first, then the one it's on); at what a move asks, that move's
// own recorded choice, when the same cards are there to choose. Anything else — a move no line has, a choice that
// can't be made as recorded — is its usual play (lookahead.js, bot.js).
let lines = [], cur = null, lineTurn = -1;
const baseOf = code => (cards[code] && cards[code][0]) || code;        // (an alternate artwork: the card it is)
const IDLE = m => [m.summons, m.special_summons, m.pos_changes, m.monster_sets, m.spell_sets, m.activates];
const fixed = r => (r && r.type === 16 ? { ...r, races: (r.races || []).map(x => BigInt(x)) } : r);   // (a Type: 64-bit)
function shuffler(s) {
  let r = Number(s % 2147483647n) || 1;
  const rand = () => (r = (r * 48271) % 2147483647) / 2147483647;
  return a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
}
const EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;
const isExtra = code => ((cards[code] || [])[2] & EXTRA) !== 0;
// what an answer chose at its prompt
function entryOf(ask, r) {
  const code = c => (c ? baseOf(c.code) : 0), none = r.index === null || r.index === undefined;
  switch (ask.type) {
    case 11: {
      const c = (IDLE(ask)[r.action] || [])[r.index];
      return c ? { t: 11, action: r.action, code: code(c), loc: c.location, desc: String(c.description ?? '') } : { t: 11, phase: true };
    }
    case 10: return { t: 10 };
    case 16: return { t: 16, code: none ? 0 : code(ask.selects[r.index]), desc: none ? '' : String((ask.selects[r.index] || {}).description ?? '') };
    case 12: case 13: return { t: ask.type, yes: !!r.yes };
    case 14: return { t: 14, index: r.index, desc: String(ask.options[r.index] ?? '') };
    case 15: case 20: case 23: return r.indicies ? { t: ask.type, codes: r.indicies.map(i => code(ask.selects[i])) } : { t: ask.type, skip: true };
    case 26: return none ? { t: 26, code: 0 } : r.index < ask.select_cards.length ? { t: 26, code: code(ask.select_cards[r.index]) } : { t: 26, skip: true };
    case 18: case 24: return { t: ask.type, places: r.places || [] };
    case 19: return { t: 19, position: r.position };
    default: return { t: ask.type, r };
  }
}
// a combo → its line (the duel it was, played again: its answers at your prompts, the engine's own passes as they were)
function lineOf(c) {
  const keep = spec, out = [];
  let h = null;
  try {
    const s = BigInt(c.seed || 1), sh = shuffler(s), all = [...(c.main || []), ...(c.extra || [])];
    spec = { s, decks: [{ main: sh(all.filter(x => !isExtra(x))), extra: all.filter(isExtra) }, { main: [], extra: [] }], board: null,
             hand: c.hand && c.hand.length ? c.hand : null, rules: null, handDraw: 0 };
    h = makeDuel(false);
    const quiet = { lib, handle: h, cards: ctx.cards, turn: 1, phase: '', level: 'normal', trigger: {} };
    let i = 0;
    for (let n = 0; n < 8000 && i < c.answers.length; n++) {
      const st = lib.duelProcess(h);
      let ask = null, stop = st === OcgProcessResult.END;
      for (const m of lib.duelGetMessage(h)) {
        if (m.type === 5 || m.type === 1 || (m.type === 40 && m.player === 1)) stop = true;     // (over, an answer refused, your turn's end)
        if (ASK.has(m.type)) ask = m;
      }
      if (stop) break;
      if (st === OcgProcessResult.CONTINUE || !ask) continue;
      let r;
      if (ask.player !== 0) r = decide(ask, quiet);                                              // (no one across the field)
      else if (ask.type === 16 && !ask.selects.length && !ask.forced) r = { type: 8, index: null };   // (passed for you, as it was)
      else { r = c.answers[i++]; const e = r && entryOf(ask, r); if (e) out.push(e); }
      lib.duelSetResponse(h, fixed(r));
    }
  } catch { /* (a combo that can't be read: what was read of it) */ }
  finally { if (h) { try { lib.destroyDuel(h); } catch {} } spec = keep; }
  return out;
}
// the recorded choice as an answer to this prompt — null when it can't be made as it was
function choiceFor(ask, e) {
  const pickCodes = () => {
    const used = new Set(), out = [];
    for (const want of e.codes) {
      const i = ask.selects.findIndex((c, j) => !used.has(j) && baseOf(c.code) === want);
      if (i < 0) return null;
      used.add(i); out.push(i);
    }
    return out;
  };
  switch (ask.type) {
    case 15: case 20: case 23: {
      const idx = e.skip ? null : pickCodes();
      if (!idx || (ask.type !== 23 && (idx.length < ask.min || idx.length > ask.max))) return null;
      return { type: ask.type === 15 ? 5 : ask.type === 20 ? 12 : 14, indicies: idx };
    }
    case 26: {
      if (e.skip) return null;
      if (!e.code) return ask.can_finish ? { type: 7, index: null } : null;
      const i = ask.select_cards.findIndex(c => baseOf(c.code) === e.code);
      return i < 0 ? null : { type: 7, index: i };
    }
    case 16: {
      if (!e.code) return ask.forced ? null : { type: 8, index: null };
      let i = ask.selects.findIndex(c => baseOf(c.code) === e.code && String(c.description ?? '') === e.desc);
      if (i < 0) i = ask.selects.findIndex(c => baseOf(c.code) === e.code);
      return i < 0 ? null : { type: 8, index: i };
    }
    case 12: return { type: 2, yes: e.yes };
    case 13: return { type: 3, yes: e.yes };
    case 14: {
      let i = ask.options.findIndex(d => String(d ?? '') === e.desc);
      if (i < 0) i = e.index < ask.options.length ? e.index : -1;
      return i < 0 ? null : { type: 4, index: i };
    }
    case 18: case 24: {   // (the zones as recorded, each still free: a set bit of field_mask is one that isn't)
      if (e.places.length !== ask.count) return null;
      const places = e.places.map(pl => ({ player: pl.player === 0 ? ask.player : 1 - ask.player, location: pl.location, sequence: pl.sequence }));
      const free = pl => !((ask.field_mask >>> ((pl.player === ask.player ? 0 : 16) + (pl.location === LOC.SZONE ? 8 : 0) + pl.sequence)) & 1);
      return places.every(free) ? { type: ask.type === 18 ? 10 : 9, places } : null;
    }
    case 19: return ask.positions & e.position ? { type: 11, position: e.position } : null;
    default: return e.r || null;
  }
}
function follow(ask) {
  if (!lines.length || ctx.level === 'easy' || ctx.turnPlayer !== ask.player) return null;
  if (lineTurn !== ctx.turn) {        // (its turn starting: every line whole again, the one its hand fits best first)
    lineTurn = ctx.turn; cur = null;
    const inHand = new Set(lib.duelQueryLocation(handle, { flags: 0x1, controller: ask.player, location: LOC.HAND, overlaySequence: 0 }).filter(c => c && c.code).map(c => baseOf(c.code)));
    for (const L of lines) { for (const e of L) e.used = false; L.fit = new Set(L.filter(e => e.t === 11 && e.loc === LOC.HAND && inHand.has(e.code)).map(e => e.code)).size; }
    lines.sort((a, b) => b.fit - a.fit);
  }
  if (ask.type === 11) {
    cur = null;
    for (const L of lines) for (let i = 0; i < L.length; i++) {
      const e = L[i];
      if (e.t !== 11 || e.used || e.phase) continue;
      const list = IDLE(ask)[e.action] || [];
      let at = list.findIndex(c => baseOf(c.code) === e.code && c.location === e.loc && (e.action !== 5 || String(c.description ?? '') === e.desc));
      if (at < 0 && e.action === 5) at = list.findIndex(c => baseOf(c.code) === e.code && c.location === e.loc);
      if (at < 0) continue;
      e.used = true; cur = { L, i: i + 1 };
      lines = [L, ...lines.filter(x => x !== L)];                    // (on with this line next)
      return { type: 1, action: e.action, index: at };
    }
    return null;
  }
  if (!cur) return null;
  // (what the move asks: its own choices in the line, up to the next move —
  //  the first of its kind that can be made as it was — a card to chain before a pass)
  const seg = [];
  for (let i = cur.i; i < cur.L.length && cur.L[i].t !== 11 && cur.L[i].t !== 10; i++) if (!cur.L[i].used && cur.L[i].t === ask.type) seg.push(cur.L[i]);
  if (ask.type === 16) seg.sort((x, y) => !!y.code - !!x.code);
  for (const e of seg) { const r = choiceFor(ask, e); if (r) { e.used = true; return r; } }
  if (seg[0]) seg[0].used = true;                   // (not as recorded: that choice spent, its usual play)
  return null;
}

// a card's data as the engine wants it (cards.json keeps a list per card: see tools/fetch_data.py)
const ATTR = { EARTH: 1, WATER: 2, FIRE: 4, WIND: 8, LIGHT: 16, DARK: 32, DIVINE: 64 };
const RACE = ['Warrior', 'Spellcaster', 'Fairy', 'Fiend', 'Zombie', 'Machine', 'Aqua', 'Pyro', 'Rock', 'Winged Beast', 'Plant', 'Insect', 'Thunder', 'Dragon',
              'Beast', 'Beast-Warrior', 'Dinosaur', 'Fish', 'Sea Serpent', 'Reptile', 'Psychic', 'Divine-Beast', 'Creator God', 'Wyrm', 'Cyberse', 'Illusion'];
function cardData(code) {
  // (an endboard's Token: the data made for it — a Normal Token Monster with its stats)
  const tk = spec && spec.board && (spec.board.tokens || []).find(t => t.code === code);
  if (tk) {
    const r = RACE.findIndex(x => x.toLowerCase() === String(tk.race).toLowerCase());
    return { code, alias: 0, setcodes: [], type: 0x4011, level: tk.level, attribute: ATTR[String(tk.attribute).toUpperCase()] || 32, race: BigInt(r >= 0 ? 2 ** r : 8),
             attack: tk.atk, defense: tk.def, lscale: 0, rscale: 0, link_marker: 0 };
  }
  const c = cards[code];
  if (!c) return null;
  return { code, alias: c[0], setcodes: c[1], type: c[2], level: c[3], attribute: c[4], race: BigInt(c[5]),
           attack: c[6], defense: c[7], lscale: c[8], rscale: c[9], link_marker: c[10] };
}
// a script: the engine asks while it runs, so it's read here and now (a worker may wait on a request)
const scriptCache = {};
function script(name) {
  if (name in scriptCache) return scriptCache[name];
  const path = /^c\d+\.lua$/.test(name) ? 'official/' + name : name;
  const x = new XMLHttpRequest();
  x.open('GET', base + path, false);
  try { x.send(); } catch { return (scriptCache[name] = null); }
  return (scriptCache[name] = x.status === 200 ? x.responseText : null);
}

// the field as it is: each player's piles and zones, the cards' codes, positions and stats
function field() {
  const q = (p, l) => lib.duelQueryLocation(handle, { flags: Q, controller: p, location: l, overlaySequence: 0 })
    .map(c => c && c.code !== undefined ? { code: c.code, pos: c.position, atk: c.attack, def: c.defense, type: (cards[c.code] || [])[2] || 0 } : null);
  const f = lib.duelQueryField(handle);
  return [0, 1].map(p => ({
    lp: f.players[p].lp,
    deck: lib.duelQueryCount(handle, p, LOC.DECK),
    hand: q(p, LOC.HAND), mzone: q(p, LOC.MZONE), szone: q(p, LOC.SZONE),
    grave: q(p, LOC.GRAVE), removed: q(p, LOC.REMOVED), extra: q(p, LOC.EXTRA),
  }));
}
const plain = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v));

function run() {
  const msgs = [];
  for (let guard = 0; guard < 4000 && !over; guard++) {
    const status = lib.duelProcess(handle);
    let ask = null, step = 0;
    for (const m of lib.duelGetMessage(handle)) {
      msgs.push(m);
      step = Math.max(step, STEP_MS[m.type] || 0);
      if (m.type === 40) ctx.turn++;
      if (m.type === 41) ctx.phase = m.phase === 0x100 ? 'main2' : String(m.phase);
      if (m.type === 5) over = true;
      // (what a player last did: the bot answers the opponent's moves, not its own)
      if (m.type === 70) ctx.trigger = { by: m.controller, kind: 'chain' };
      if (m.type === 110) ctx.trigger = { by: m.card && m.card.controller, kind: 'attack' };
      if (m.type === 60 || m.type === 62 || m.type === 64) ctx.trigger = { by: m.controller, kind: 'summon' };
      if (m.type === 40) { ctx.trigger = {}; ctx.turnPlayer = m.player; }
      if (m.type === 40 && m.player === 1 && spec.endAfterTurn) { over = true; practiceOver = true; }
      if (ASK.has(m.type)) ask = m;
      if (m.type === 1) ask = lastAsk;                // (RETRY: the same prompt again)
    }
    if (over || status === OcgProcessResult.END) { over = true; post(msgs, null, practiceOver); return; }
    if (status === OcgProcessResult.CONTINUE) {
      if (botActive && step) { post(msgs, null); setTimeout(run, step * speed); return; }
      continue;
    }
    if (!ask) { postMessage({ t: 'error', text: 'The engine waited with nothing asked.' }); return; }
    lastAsk = ask;
    // (a chain prompt you can't use: passed for you, as EDOPro does)
    if (!bots[ask.player] && ask.type === 16 && !ask.selects.length && !ask.forced) { answer({ type: 8, index: null }); continue; }
    if (bots[ask.player]) {
      // (on its own turn, Normal and Hard look ahead: each move tried in a copy of the duel — lookahead.js)
      let r = null;
      const thinkFrom = performance.now();
      try { r = follow(ask); } catch (err) { r = null; }         // (a recorded combo's move, when it can make it)
      if (!r && choose && ctx.level !== 'easy' && ctx.turnPlayer === ask.player) {
        try { r = choose[ask.player](ask, answers, ctx, ctx.level === 'hard' ? 14 : 8); } catch (err) { r = null; }
      }
      if (!r) r = decide(ask, ctx);
      answer(r);
      botActive = true;
      // (a beat before each of its main and battle moves: what follows is stepped play by play — the time it spent
      //  thinking counted in it, not added to it)
      if (ask.type === 11 || ask.type === 10 || ask.type === 16 && ask.selects.length) {
        post(msgs, null); setTimeout(run, Math.max(0, BEAT_MS * speed - (performance.now() - thinkFrom))); return;
      }
      continue;
    }
    post(msgs, ask);
    return;
  }
}
// a duel as this one began — the real one (logged), or a copy for a trial
function makeDuel(real) {
  const { s, decks, board, hand } = spec;
  // (the duel's options: its rules, LP, opening hand and draws a turn — EDOPro's defaults if none)
  const R = spec.rules || {};
  const mode = { mr4: OcgDuelMode.MODE_MR4, mr3: OcgDuelMode.MODE_MR3, mr2: OcgDuelMode.MODE_MR2, goat: OcgDuelMode.MODE_GOAT }[R.rules] || OcgDuelMode.MODE_MR5;
  const lp = R.lp || 8000, open = R.hand ?? 5, draw = R.draw ?? 1;
  const h = lib.createDuel({
    flags: mode | (board ? OcgDuelMode.ATTACK_FIRST_TURN : 0n), seed: [s, s * 3n + 1n, s * 7n + 5n, s * 11n + 9n],
    team1: { startingLP: lp, startingDrawCount: hand ? spec.handDraw : board ? 6 : open, drawCountPerTurn: draw },
    team2: { startingLP: board ? board.lp : lp, startingDrawCount: board || !decks[1].main.length ? 0 : open, drawCountPerTurn: draw },
    cardReader: cardData, scriptReader: script,
    errorHandler: real ? (type, text) => postMessage({ t: 'log', text: String(text) }) : () => {},
  });
  for (const f of ['constant.lua', 'utility.lua']) lib.loadScript(h, f, script(f));
  decks.forEach((deck, team) => {
    for (const code of deck.main) lib.duelNewCard(h, { team, duelist: 0, code, controller: team, location: LOC.DECK, sequence: 0, position: 8 });
    for (const code of deck.extra) lib.duelNewCard(h, { team, duelist: 0, code, controller: team, location: LOC.EXTRA, sequence: 0, position: 8 });
  });
  // (your opening hand, chosen: in your hand from the start)
  if (hand) for (const code of hand) if (cards[code]) lib.duelNewCard(h, { team: 0, duelist: 0, code, controller: 0, location: LOC.HAND, sequence: 0, position: 10 });
  // (an endboard: each card where it sits, for the bot)
  if (board) for (const c of board.cards) if (cards[c.code] || c.code >= 990000000) lib.duelNewCard(h, { team: 1, duelist: 0, code: c.code, controller: 1, location: c.location, sequence: c.sequence, position: c.position });
  // (its monsters' ATK / DEF / Level as changed in the builder: an effect on each, from now till it leaves the field —
  //  the change from what the engine makes it, so the board's own boosts aren't counted twice)
  if (board && board.mods && board.mods.length) {
    const n = v => (v === undefined || v === null || v === '' || isNaN(+v)) ? 'nil' : String(Math.round(+v));
    lib.loadScript(h, 'endboard-mods.lua', `
local function rd_mod(p, seq, atk, def, lv)
  local c = Duel.GetFieldCard(p, LOCATION_MZONE, seq)
  if not c then return end
  local function eff(code, val)
    local e = Effect.CreateEffect(c)
    e:SetType(EFFECT_TYPE_SINGLE)
    e:SetProperty(EFFECT_FLAG_CANNOT_DISABLE + EFFECT_FLAG_SINGLE_RANGE)
    e:SetRange(LOCATION_MZONE)
    e:SetCode(code)
    e:SetValue(val)
    e:SetReset(RESET_EVENT + RESETS_STANDARD)
    c:RegisterEffect(e)
  end
  if atk then eff(EFFECT_UPDATE_ATTACK, atk - c:GetAttack()) end
  if def and not c:IsType(TYPE_LINK) then eff(EFFECT_UPDATE_DEFENSE, def - c:GetDefense()) end
  if lv then eff(EFFECT_CHANGE_LEVEL, lv) end
end
${board.mods.map(m => `rd_mod(1, ${m.sequence}, ${n(m.atk)}, ${n(m.def)}, ${n(m.level)})`).join('\n')}
`);
  }
  lib.startDuel(h);
  return h;
}
function answer(r) {
  answers.push(r);
  lib.duelSetResponse(handle, fixed(r));
}
function post(msgs, ask, practice) { postMessage({ t: 'update', msgs: plain(msgs), field: field(), ask: ask && plain(ask), turn: ctx.turn, practiceOver: !!practice }); }

onmessage = async e => {
  const d = e.data;
  try {
    if (d.t === 'start') {
      base = d.scripts;
      bots = d.bots;
      speed = { slow: 1.7, normal: 1, fast: .4 }[d.speed] || 1;
      const [cj, wasm] = await Promise.all([fetch(base + 'cards.json').then(r => r.json()),
                                            fetch(new URL('./vendor/ocgcore-wasm/ocgcore.sync.wasm', import.meta.url)).then(r => r.arrayBuffer())]);
      cards = cj;
      lib = await createCore({ sync: true, wasmBinary: wasm });
      const s = BigInt(d.seed || Math.floor(Math.random() * 2 ** 31) + 1);
      // (the Deck in the order given: shuffled here, from the seed)
      const shuffle = shuffler(s);
      // (an Extra Deck monster goes to the Extra Deck by its type, whichever part of the list it was in)
      d.decks = d.decks.map(k => { const all = [...k.main, ...k.extra]; return { main: all.filter(c => !isExtra(c)), extra: all.filter(isExtra) }; });
      spec = { s, decks: d.decks.map(k => ({ main: shuffle(k.main), extra: k.extra })), board: d.board || null, hand: d.hand && d.hand.length ? d.hand : null,
               rules: d.rules || null, handDraw: Math.max(0, Math.min(5, +d.handDraw || 0)) };
      // (an endboard with no deck behind it, or the Combo Lab's empty field: the practice is your turn)
      spec.endAfterTurn = (!!d.board && !d.decks[1].main.length) || !!d.lab;
      handle = makeDuel(true);
      choose = [0, 1].map(seat => lookahead({ lib, makeDuel: () => makeDuel(false), decide, seat }));
      const names = d.names || {};
      ctx = { lib, handle, cards: new Proxy({}, { get: (_, k) => { const c = cards[k]; return c && { type: c[2], attack: c[6], defense: c[7], level: c[3], name: names[k] || '' }; } }),
              turn: 0, phase: '', level: d.level || 'normal' };
      // (the bot's combos: each read into its line — one with no move in it left out; the page told how many)
      lines = []; cur = null; lineTurn = -1;
      if (Array.isArray(d.combos) && d.combos.length) {
        lines = d.combos.slice(0, 12).map(lineOf).filter(L => L.some(e => e.t === 11 && !e.phase));
        postMessage({ t: 'combos', read: lines.length, of: d.combos.length, moves: lines.map(L => L.filter(e => e.t === 11 && !e.phase).length) });
      }
      run();
    } else if (d.t === 'answer') {
      answer(d.r);
      botActive = false;                            // (your move: shown at once)
      run();
    } else if (d.t === 'speed') {
      speed = { slow: 1.7, normal: 1, fast: .4 }[d.v] || 1;
    } else if (d.t === 'replay') {
      postMessage({ t: 'replay', answers: plain(answers) });
    }
  } catch (err) {
    postMessage({ t: 'error', text: String(err && err.stack || err) });
  }
};
