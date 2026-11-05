# BanishZone Rules Duel

The Rules Duel on BanishZone (sim.banishzone.ro and the BanishZone Tools app) is a Yu-Gi-Oh! duel with the
rules enforced. A rules engine plays every card's effect, and you choose from what the rules allow.

This folder is that duel's code. It is **free software under the GNU Affero General Public License,
version 3 or later** (see `LICENSE.md`), because it is built on two AGPL projects:

- **ygopro-core**, EDOPro's rules engine, by edo9300 and Project Ignis: <https://github.com/edo9300/ygopro-core>.
  It is used here as compiled to WebAssembly by **ocgcore-wasm** 0.1.6, by n1xx1 (the wrapper is MIT, see
  `vendor/ocgcore-wasm/LICENSE.md`): <https://github.com/n1xx1/ocgcore-wasm>. It is unmodified; its
  corresponding source is the ygopro-core version that ocgcore-wasm 0.1.6 builds from.
- **Project Ignis' card scripts**, one Lua script per card: <https://github.com/ProjectIgnis/CardScripts>,
  at commit `2bd02f71383b87d7dee174909a96d10491930c45`. They are unmodified.

Card statistics (type, Level, ATK/DEF, archetypes) come from Project Ignis' card database,
<https://github.com/ProjectIgnis/BabelCDB>, at commit `781ec580fb82ced7cd17bae290ee2985824a0def`.
EDOPro's own texts (what a card's choice says when its script names one by number, "Add the card(s) to your hand")
come from Project Ignis' Distribution, <https://github.com/ProjectIgnis/Distribution> (AGPL-3.0), its
`config/strings.conf` at commit `54a6e2395c532648ff762540e9615319fac4f51b`.
Yu-Gi-Oh! is a trademark of Shueisha and Konami. This project is not affiliated with or endorsed by them.

## What's here

| File | What it does |
| --- | --- |
| `engine-worker.js` | Runs the engine in a Web Worker: loads the cards and scripts, runs the duel, and answers the bot's prompts |
| `bot.js` | The bot: it picks one of the moves the engine allows |
| `rules-duel.js` | The page side: turns the engine's field into the duel board's drawing, and your taps into the engine's answers |
| `lookahead.js` | The bot's look-ahead: tries a move on a copy of the duel to see where it leads |
| `vendor/ocgcore-wasm/` | The engine (ocgcore-wasm 0.1.6: `dist/` and `lib/ocgcore.sync.wasm`, unmodified) |
| `tools/fetch_data.py` | Fetches the card scripts and builds `cards.json`, `strings.json` and `system.json` at the versions above (into `assets/duel-scripts/`) |

The rest of BanishZone is not part of this program. That includes the duel board that draws the field
(it receives plain data from `rules-duel.js`), the deck builder, accounts and the server. They talk to the
Rules Duel only through plain data: a deck list in, the moves out.

## Getting the source

The source is this repository, <https://github.com/VladBlaga95/banishzone-rules-duel>, which holds the files exactly as the site
serves them, unminified, under `/duel-engine/` (for example, `/duel-engine/rules-duel.js`). `VERSION.txt`
names the BanishZone commit they come from.

## Building it

Nothing here is compiled except the engine. The `.js` files run as they are, in a browser's Web Worker.

**The engine** (`vendor/ocgcore-wasm/`) is the npm package `ocgcore-wasm@0.1.6`, unchanged. Its
`ocgcore.sync.wasm` and `index.js` have the same SHA-256 as the package's `lib/ocgcore.sync.wasm` and
`dist/index.js`. To build it from source:

1. Clone <https://github.com/n1xx1/ocgcore-wasm> at commit `21c26abd352f1323b578c0b8f49bf8b3d2ceb6a1`
   (the "0.1.6" commit), with its submodule `cpp/ygo`. That is ygopro-core at commit
   `baa3881d0bae48e9994f915f5c931be53c1ba8ef`, with the Lua interpreter it bundles.
2. With Emscripten installed, run `npm run build` (that runs `scripts/build.sh` and then the JS wrapper's
   build). The files this module uses are `lib/ocgcore.sync.wasm` and `dist/*.js`.

**The card scripts and statistics** are not stored here. Run `python tools/fetch_data.py` to fetch Project
Ignis' scripts, database and system texts at the commits named above and build `cards.json`, `strings.json` and
`system.json`, into `duel-scripts/`
(in BanishZone itself, `assets/duel-scripts/`). The site serves that folder as `/duel-scripts/`, where
`rules-duel.js` and `engine-worker.js` load it from.
