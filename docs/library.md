# Using argus-elytra-mapper as a library

```bash
npm install github:fpvwraith/Mineflayer-Elytra-Mapper     # from GitHub
npm install argus-elytra-mapper                            # once it is published to npm
```

```js
const mapper = require('argus-elytra-mapper');
```

Requires Node 18 or newer. Importing the package loads mineflayer. If you only need the region writer or the planner,
import the smaller entry points: `argus-elytra-mapper/writer` and `argus-elytra-mapper/planner`.

## createMapper(config, [options])

Builds a mapper from a config object (same shape as `config.json`, see [config.md](config.md); defaults are filled in and
mistakes throw a `ConfigError` whose `.errors` lists every problem). Nothing connects until `start()`.

```js
const { createMapper } = require('argus-elytra-mapper');

const m = createMapper({
  account: { username: 'MyBot', auth: 'microsoft' },
  mapping: { mode: 'box', box: { x1: 20000, z1: 20000, x2: 24000, z2: 24000 } },
  output: { dir: './out' },
});

m.on('region', ({ rx, rz, file }) => console.log('region written', rx, rz, file));
m.on('kicked', ({ kind, reason }) => console.warn('kicked:', kind, reason));
m.on('state', (s) => console.log(s.connection, s.mapping.state));

await m.start();
// ... later
await m.stop();   // stops flying, writes every region still in memory, writes status.json
```

Options (second argument): `{ env, console, fetchImpl }`. `env` replaces `process.env` for the secret overrides,
`console: false` silences stdout (use the `log` event), `fetchImpl` replaces `fetch` (tests).

Methods:

| Method | Returns | Meaning |
|---|---|---|
| `start()` | Promise | Connects, reaches the main server, and (with `mapping.autoStart`) starts mapping. |
| `stop()` | Promise | Graceful shutdown. A run that was active resumes on the next start. |
| `status()` | object | Snapshot: `connection`, `mapping` (state, mode, position, covered/waypoints), `recorder` (chunks, regions), `output`, `memory`, `lastError`. |
| `startMapping(mode)` | Promise of string | Start or switch mapping. `mode` as in `mapping.mode`, including `box:x1,z1,x2,z2`, `boxes`, `needed`. |
| `stopMapping()` | string | Stop the run (the bot stays connected). |
| `refreshNeeded()` | Promise of number | Re-fetch the needed areas. |
| `getBot()` | mineflayer bot or null | The current bot, for your own plugins. |

Events:

| Event | Payload |
|---|---|
| `region` | `{ rx, rz, file, dimension }` after a region zip was written |
| `chunk` | `{ cx, cz }` after a chunk was recorded (only emitted while someone listens) |
| `state` | `{ connection, mapping, detail }`; `connection` is `connecting`, `lobby`, `main`, `reconnecting`, `kicked`, `captcha`, `stopped` |
| `kicked` | `{ reason, kind: 'captcha' \| 'rate-limit' \| 'other', retryInSec }` |
| `log` | `{ time, level, msg }` for every log line that passes `log.level` |

## createRegionWriter({ outDir, dimension })

The Xaero region writer on its own, for any source of chunk columns.

```js
const { createRegionWriter, columnFromPrismarine } = require('argus-elytra-mapper');

const w = createRegionWriter({ outDir: './regions/overworld', dimension: 'overworld' });

// x and z passed to the accessor are chunk-local (0..15). A column is plain data:
// { state, props?, height, light?, biome?, waterOverlay?, topHeight?, waterDepth?, overlayLight? }
w.ingestChunk(chunkX, chunkZ, (x, z) => columnFromPrismarine(bot.world.getColumn(chunkX, chunkZ), x, z, { registry: bot.registry }));

await w.flush(rx, rz);              // write one region (atomic)
await w.flushAll();                 // write every region with new data
await w.evictOlderThan(5 * 60000);  // write and forget regions idle for 5 minutes
w.stats();                          // { regions, chunks, approxBytes, ... }
```

Also exported: `encodeRegion(columns)`, `decodeRegion(buffer)`, `zipRegion(buffer)`, `unzipRegion(zip)`. Format notes:
[xaero-format.md](xaero-format.md).

## Planning helpers

```js
const { planBox, boxRegions, neededRegions, neededToBoxes, regionAllowed } = require('argus-elytra-mapper');

planBox([20000, 20000, 24000, 24000]);         // [{x, z}, ...] flight waypoints, centre outward, guards applied
boxRegions([20000, 20000, 24000, 24000]);      // [{rx, rz}, ...] regions the box touches

// optional, read-only: one GET of a public list of areas an ARGUS community map still lacks
const parsed = await neededRegions({ url: 'https://map.argus.tools', limit: 40 });
neededToBoxes(parsed, { maxCells: 10 });       // [[x1, z1, x2, z2], ...] bounty first, then by ring

regionAllowed(0, 0);                           // false: lobby area
regionAllowed(300, 0);                         // false: beyond 150000 blocks
```

`parseNeeded(json)` validates a response you fetched yourself.

## Config helpers

`resolveConfig(obj, { env })` returns `{ config, warnings }` or throws `ConfigError`. `loadConfigFile(path)` does the same
for a JSON file plus a `.env`.

## Writing your own flight logic

`createMapper` is the batteries-included path. The flight state machine (`lib/mapper.js`) is tuned for 6b6t and is not
part of the public API. If your server or your flight style is different, use `createRegionWriter` with your own
`chunkColumnLoad` handler. Honour the guards (`regionAllowed`) when you do.
