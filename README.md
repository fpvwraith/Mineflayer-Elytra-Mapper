# Elytra Mapper

An autonomous **elytra terrain mapper** for 6b6t-style anarchy servers. It flies a Minecraft bot over the server and
saves what it sees as **Xaero World Map compatible region files**
(`output/regions/<dimension>/<rx>_<rz>.zip`) that you can open in Xaero's World Map or process with your own tools. Use
it as a command line tool or as a Node library. Everything stays on your disk: the tool does not upload anything.

- Runs unattended for days: reconnects with backoff, walks through the 6b6t proxy lobby, restarts the elytra cycle after
  every death.
- Low memory: far chunks are dropped, regions are written to disk when they go quiet.
- Guards: skips the spawn/lobby area by default and never goes beyond a configurable distance.
- Plans from a rectangle, a list of rectangles, or a compass highway.
- MIT licensed, no secrets in the repository.

> Use an account you can afford to lose, follow the rules of the server you play on, and do not map areas you must not.
> See [Rules of the road](#rules-of-the-road).

## Requirements

- Node.js 18 or newer (`node -v`).
- A Minecraft account for the bot: a premium (Microsoft) account, or an offline name if the server allows it.
- In the game: a bed, an ender chest with elytras, and a `/home` on a launch platform (see step 2 below).

## Quick start

**1. Install**

```bash
git clone https://github.com/fpvwraith/Mineflayer-Elytra-Mapper.git
cd Mineflayer-Elytra-Mapper
npm install        # add --omit=optional to skip the Discord control bot
```

**2. Set up the account in the game (once)**

1. Far base outside the server's no-`/home` radius (5,000 blocks on 6b6t): sleep in a **bed** there so it is the respawn
   point, with an **ender chest** within a few blocks.
2. Fill the ender chest with **elytras**, ideally shulker boxes full of them (the bot opens one when it needs an elytra;
   ender chest contents are shared, so any ender chest works).
3. Build a small **launch platform** with a clear edge near the area you want to map and set a home on it
   (`/sethome spawn`). Put that name in `mapping.homeName`.

No fireworks are needed: the flight uses mineflayer's firework-boost physics without consuming rockets. If your bed and
launch platform are the same place, that works too.

**3. Configure**

```bash
cp config.example.json config.json
```

Edit `account.username` (and `account.auth`, `loginPassword` if needed) and choose what to map, for example:

```json
"mapping": { "mode": "box", "box": { "x1": 20000, "z1": 20000, "x2": 24000, "z2": 24000 }, "homeName": "spawn" }
```

**4. Check without connecting**

```bash
node bin/argus-mapper.js --dry-run
```

It validates the config, prints the plan (number of waypoints, guards, output folder) and writes nothing.

**5. Run**

```bash
node bin/argus-mapper.js
```

The bot connects, reaches the main server, and starts mapping. Region files appear in `output/regions/overworld/`.
Stop it with Ctrl+C: it writes every region still in memory before exiting. Check on it from another terminal:

```bash
node bin/argus-mapper.js status
```

`npm link` (or `npm install -g .`) installs the short command `argus-mapper` so you can drop the `node bin/...` prefix.
Keep it alive on a server with a process manager (pm2, systemd). Config errors exit with code 2 and a readable message.

## Modes

Set `mapping.mode` in the config, or override with `--mode`.

| Mode | What it maps |
|---|---|
| `box` | A rectangle (`mapping.box`), grid-filled from the centre outward. |
| `boxes` | A list of rectangles (`mapping.boxes`). |
| `ring`, `ring-nw/ne/se/sw` | The +-10,000 box around spawn without the middle circle; quadrants map one corner. |
| `spawn` | The +-5,000 box around spawn. |
| `north` ... `nw` | One compass highway out toward the world border. |
| `rotate` | All eight highways in turn. |
| `needed` | Optional, off by default: plan flights from a public list of areas an ARGUS community map still lacks. Read-only (one GET of `mapping.neededUrl` + `/api/needed-regions`), no account, nothing is sent. |

Every mode skips the lobby area (`mapping.skipSpawnRegions`) and anything beyond `limits.maxAbsBlock` (150,000 by
default). `node bin/argus-mapper.js needed` prints the current list for `needed` mode.

## Output

```
output/
  regions/<dimension>/<rx>_<rz>.zip   Xaero World Map region files (512 x 512 blocks each)
  tiles/tile_<cellX>_<cellZ>.png      only with output.tiles = true
  manifest.json                       index of the PNG tiles
  coverage.json                       where the bot already flew (a restart skips it)
  mapper-state.json                   on/off and mode, so a restart resumes
  status.json                         live snapshot for `argus-mapper status`
```

- **Region zips** are the main output: one `region.xaero` entry per zip, Xaero World Map format 7.8. A region is 512 x 512
  blocks and `rx = floor(blockX / 512)`. Format notes: [docs/xaero-format.md](docs/xaero-format.md).
- **PNG tiles** are optional (`output.tiles`, default off): top-down block-texture renders, about 1.5 s of CPU each.

## What you can do with the region files

- **Open them in Xaero's World Map.** Copy the zips into the map folder of a world and dimension in your Xaero World Map
  data (back up that folder first), and the explored area shows up in the game.
- **Convert them.** The format is documented and the bundled codec (`decodeRegion`) reads it, so you can turn the files
  into images, heightmaps or any other format.
- **Build your own map site.** Render the regions to tiles and serve them with any web map library.
- **Merge runs.** Re-running into the same folder merges new chunks into existing files, newest data wins.

## Library usage

```js
const { createMapper, createRegionWriter, planBox } = require('argus-elytra-mapper');

const mapper = createMapper({
  account: { username: 'MyBot' },
  mapping: { mode: 'box', box: { x1: 20000, z1: 20000, x2: 24000, z2: 24000 } },
});
mapper.on('region', (r) => console.log('wrote', r.file));
mapper.on('kicked', (k) => console.warn(k.kind, k.reason));
await mapper.start();
// ...
await mapper.stop();          // flushes regions
```

The region writer and the planner also work on their own. Full reference: [docs/library.md](docs/library.md).

## Configuration

Everything is in `config.json` (see [config.example.json](config.example.json)); [docs/config.md](docs/config.md) lists
every key. The ones most people touch:

| Key | Default | Meaning |
|---|---|---|
| `account.username`, `auth` | required, `offline` | The bot account; `microsoft` for a premium login. |
| `server.host`, `version` | `mc.6b6t.org`, `1.21.11` | Where to connect. |
| `server.directConnect` | `false` | `true` for a normal server without a proxy lobby. |
| `server.viewDistance` | server default | Fewer chunks means less memory. |
| `mapping.mode`, `box`, `boxes` | `ring` | What to map. |
| `mapping.homeName` | `spawn` | The `/home` of your launch platform. |
| `mapping.skipSpawnRegions` | `true` | Never record the lobby area. |
| `limits.maxAbsBlock` | `150000` | Never plan or record beyond this distance from 0,0. |
| `output.dir` | `./output` | Where everything is written. |
| `output.tiles` | `false` | Also write PNG tiles. |
| `memory.pruneChunks`, `keepChunks` | `true`, `18` | Drop far chunks to keep memory flat. |
| `connection.captchaCooldownMin` | `60` | Wait after an anti-bot kick; `0` = stay stopped. |
| `log.format` | `text` | `json` for one JSON object per line. |

Secrets can come from the environment instead of the file: `MAPPER_LOGIN_PASSWORD` and `DISCORD_TOKEN` (also read from a
`.env` file).

## Rules of the road

- 6b6t allows **3 accounts per IPv4 address**. One mapper on your own connection is fine; do not exceed what the server
  allows.
- **Respect the server's rules.** The mapper reads terrain from chunks the server sends and does not grief, raid or attack,
  but you are responsible for the account.
- **Use an account you are fine losing.** Flying bots get kicked, and every run ends in a death by design.
- **Do not map areas you must not.** The lobby area is skipped by default.
- Anti-bot / captcha kicks are never solved by the mapper. It stops and tells you. See [docs/6b6t-notes.md](docs/6b6t-notes.md).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Invalid config:` followed by a list | Fix each line; `--dry-run` re-checks without connecting. |
| Stuck in the lobby | The proxy lobby differs from 6b6t's: set `server.lobbyBox`, or `server.directConnect: true`. |
| Kicked with an anti-bot message | Log in to the account with a normal client and complete it. The mapper waits `connection.captchaCooldownMin` minutes. |
| "Out of elytras" | Restock the ender chest, then restart. |
| Auto-stopped after recovery `/kill`s | The bed was lost. Sleep in the far-base bed again. |
| "skipped an unparseable packet" | A corrupt chunk; harmless, the bot stays connected. |
| No region files appear | Regions are written about a minute after the last chunk in them (`output.flushIdleSec`) and on shutdown. Check `status`; chunks in the lobby area or beyond `limits.maxAbsBlock` are skipped on purpose. |
| High memory | Lower `server.viewDistance`, keep `memory.pruneChunks` on, keep `output.tiles` off. |

## FAQ

**Does it upload anything?** No. It saves files to your disk and, in the optional `needed` mode only, reads one public list.

**Can I load the files in Xaero's World Map?** Yes, they are in its region format. Copy them into the world's map folder
for the right dimension.

**Does it work on other servers?** The flight and proxy-lobby logic is tuned for 6b6t. Servers with an elytra-friendly
spawn and `server.directConnect: true` can work; expect to adjust `mapping.*`.

**Is the Nether or End supported?** The writer can tag them, but the flight loop is built for the overworld and nether/end
output is untested.

**Why was uploading removed?** The v1 tile upload endpoint no longer exists, and the tool is now a local mapper.

## Contributing

Issues and pull requests are welcome. Run `npm test` before sending a change (no Minecraft server or network needed).
Keep secrets, coordinates of private places and account names out of commits, issues and logs.

## License

MIT, see [LICENSE](LICENSE). Changes: [CHANGELOG.md](CHANGELOG.md).
