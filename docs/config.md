# Configuration reference

The CLI reads `config.json` in the working directory (or `--config FILE`). Copy `config.example.json` and edit it.
Every key is optional except `account.username`; missing keys take the defaults below. A mistake produces one error
message per problem and the mapper does not start (`argus-mapper --dry-run` checks the file without connecting).

Secrets can live outside the file. These environment variables (or lines in a `.env` file next to the config) win over
the file:

| Variable | Overrides |
|---|---|
| `MAPPER_LOGIN_PASSWORD` | `account.loginPassword` |
| `DISCORD_TOKEN` | `discord.token` |

Never commit `config.json` or `.env`. Both are in `.gitignore`.

## account

| Key | Default | Meaning |
|---|---|---|
| `auth` | `"offline"` | `"offline"` (name only, for servers that allow it) or `"microsoft"` (premium; the first run prints a device-code link, the login is cached in `profilesFolder`). |
| `username` | required | The bot's Minecraft account name. Use an account you can afford to lose. |
| `loginPassword` | `""` | For servers with an AuthMe-style `/login` on offline accounts. Prefer `MAPPER_LOGIN_PASSWORD`. |
| `profilesFolder` | `"./auth_cache"` | Where the Microsoft login cache is stored. Keep it private. |

## server

| Key | Default | Meaning |
|---|---|---|
| `host`, `port` | `mc.6b6t.org`, `25565` | Server address. |
| `version` | `"1.21.11"` | Minecraft protocol version (must be supported by mineflayer). |
| `directConnect` | `false` | `false` = do the 6b6t proxy-lobby to portal walk. `true` for a normal server where you spawn on the main world. |
| `lobbyBox` | `null` | `{minX,maxX,minZ,maxZ}` of the proxy lobby if your server's differs from 6b6t's. |
| `viewDistance` | `null` | Chunks the client asks the server for (2 to 32). Lower means less memory and CPU but a narrower mapped strip. `null` = mineflayer's default. |

## mapping

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"ring"` | What to map, see [modes](#modes). |
| `box` | `null` | For `mode: "box"`: `{x1,z1,x2,z2}`, two opposite corners. |
| `boxes` | `[]` | For `mode: "boxes"`: a list of boxes, each `{x1,z1,x2,z2}` or `[x1,z1,x2,z2]`. |
| `homeName` | `"spawn"` | The `/home` name of your launch platform. |
| `autoStart` | `true` | Start mapping as soon as the bot is on the main server. A run that was active when the process last stopped always resumes. |
| `noHomeRadius` | `5000` | Radius around 0,0 in which the server blocks `/home` (6b6t: 5,000). Inside it the bot cannot commute by `/home`. |
| `homeCooldownSec` | `315` | The server's `/home` cooldown plus a margin. |
| `skipSpawnRegions` | `true` | Never record the lobby area: regions with \|rx\| <= 1 and \|rz\| <= 1 (blocks -512 to 1023). Also drops those waypoints from the plan. Turn it off only on a server where that area is yours to map. |
| `neededUrl` | `"https://map.argus.tools"` | `needed` mode only: base URL of the public list (`<neededUrl>/api/needed-regions`). |
| `neededLimit` | `40` | `needed` mode: how many areas to fetch. |
| `neededRefreshMin` | `30` | `needed` mode: how often the list is refreshed (used on the next run of the loop). |

### Modes

| Mode | What it maps |
|---|---|
| `box` | One rectangle (`mapping.box`), grid-filled from the centre outward. |
| `boxes` | Several rectangles (`mapping.boxes`) in one run. |
| `needed` | Optional: plan flights from a public list of areas an ARGUS community map still lacks. It is read-only (one GET of `<mapping.neededUrl>/api/needed-regions`), needs no account and sends nothing. Off unless you choose this mode. |
| `ring`, `ring-nw`, `ring-ne`, `ring-se`, `ring-sw` | The +-10,000 box around spawn without the middle 5,300 block circle. Quadrant variants map one corner. |
| `spawn` | The +-5,000 box around spawn. |
| `north`, `south`, `east`, `west`, `ne`, `nw`, `se`, `sw` | One straight highway out from spawn toward the world border. |
| `rotate` | All eight highways in turn, one elytra run each. |

The spawn guard (`mapping.skipSpawnRegions`) and `limits.maxAbsBlock` apply to every mode: waypoints in guarded regions or
beyond the limit are dropped from the plan, and chunks there are not recorded.

## limits

| Key | Default | Meaning |
|---|---|---|
| `maxAbsBlock` | `150000` | Nothing beyond this many blocks from 0,0 is planned or recorded. Raise or lower it to suit your project. |

## output

| Key | Default | Meaning |
|---|---|---|
| `dir` | `"./output"` | Output folder, see the layout in the README. |
| `dimension` | `"overworld"` | Dimension tag for the region files. The flight logic is built for the overworld; nether and end output is untested. |
| `regions` | `true` | Write Xaero World Map region zips to `<dir>/regions/<dimension>/`. This is the main output. |
| `tiles` | `false` | Also write PNG tiles (`<dir>/tiles/`) and a manifest. Costs about 1.5 s of CPU per render. |
| `flushIdleSec` | `60` | Write a region to disk this long after the last chunk was added to it. |
| `evictIdleSec` | `300` | Forget a region (after writing it) this long after the last chunk was added. Keeps memory bounded. Must be >= `flushIdleSec`. |

## memory

| Key | Default | Meaning |
|---|---|---|
| `pruneChunks` | `true` | Unload chunks far behind the bot (after they were recorded). Without it, memory grows for as long as the bot flies. |
| `keepChunks` | `18` | Keep chunks within this many chunks of the bot. Keep it above the server's view distance plus a margin. |
| `pruneEverySec` | `5` | How often to prune. |

## connection

| Key | Default | Meaning |
|---|---|---|
| `reconnectBaseSec` | `15` | First reconnect delay. It doubles up to `reconnectMaxSec` and only resets after a connection survived 90 s on the main server. A +-10% jitter is added. |
| `reconnectMaxSec` | `300` | Longest reconnect delay. |
| `rateLimitCooldownSec` | `45` | Minimum wait after a "logging in too fast" style kick. |
| `captchaCooldownMin` | `60` | After an anti-bot / captcha kick: wait this long, then reconnect. `0` = do not reconnect until you restart. The mapper never tries to solve a captcha. |

## status, log, discord

| Key | Default | Meaning |
|---|---|---|
| `status.file` | `"status.json"` | Status snapshot, relative to `output.dir` unless absolute. `argus-mapper status` reads it. |
| `status.intervalSec` | `10` | How often it is rewritten. |
| `log.level` | `"info"` | `error`, `warn`, `info` or `debug`. `debug` adds the flight trace. |
| `log.format` | `"text"` | `"text"` or `"json"` (one JSON object per line: `time`, `level`, `msg`). |
| `log.file` | `null` | Also append the log to this file. Tokens and passwords are scrubbed from all log output. |
| `discord.enabled` | `false` | Optional control bot (`!map on [mode]`, `!map off`, `!map status`) in one channel of your own server. Needs `discord.token` and `discord.channelId`; install with `npm install discord.js` if it was skipped. |
