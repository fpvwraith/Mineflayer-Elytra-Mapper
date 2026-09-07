# ARGUS Mapper

A standalone, self-hostable **autonomous elytra terrain mapper** for 6b6t-style
anarchy servers. It flies your Minecraft account around spawn on an elytra,
renders the terrain it sees into PNG map tiles, saves them to a local folder, and
(optionally) uploads them to an [ARGUS](https://map.argus.tools) community map.

Run it on your own PC or a VPS, with your own Minecraft account and (optionally)
your own Discord bot. **No tokens or secrets are hardcoded** — everything comes
from a gitignored `config.json` or environment variables.

It renders pixel-for-pixel the same way the main ARGUS project does (same block
palette, biome tints, and hillshade), so your tiles composite cleanly with
everyone else's.

---

## How it works

Two-base loop, designed to run unattended for days:

1. Respawn on a **bed** (your "far base") next to an **ender chest of elytras**.
2. Grab an elytra (loose, or cracked out of a shulker box).
3. `/home <name>` to a **launch platform** near the area you want to map.
4. Step off the edge, deploy the elytra, firework-boost, and cruise in long
   sweeps — rendering the terrain below into tiles as it flies.
5. Elytra wears out → fall → die → respawn on the bed → repeat.

It tracks what it has already covered (persisted to disk), routes around the
dodgy spawn centre, survives corrupt-chunk parse errors, and reconnects with
backoff through 6b6t's proxy-lobby → portal handoff.

---

## Requirements

- **Node.js 18 or newer** (`node -v`).
- A **Minecraft account** for the bot — either a premium (Microsoft) account, or
  an offline/cracked name if your server allows it. **Use an account you're okay
  running as a bot.**
- An **elytra + fireworks** stocked in-game (see setup below).
- Rank/perk with a usable `/home` on your server helps a lot (the mapper commutes
  via `/home`). Not strictly required if your bed *is* your launch spot.

---

## Install

```bash
git clone <your-fork-url> argus-mapper
cd argus-mapper
npm install
cp config.example.json config.json   # then edit config.json
```

Headless (no Discord)? Skip the optional Discord dependency:

```bash
npm install --omit=optional
```

---

## In-game setup (do this once, on the bot account)

The mapper needs two things set up in the world:

1. **Far base** — somewhere safe, ideally **outside your server's no-`/home`
   radius** around spawn (on 6b6t that's 5,000 blocks):
   - A **bed**, and sleep in it so it's your respawn point.
   - An **ender chest** within a few blocks of the bed, filled with **elytras**
     — as loose elytras (27 max) or, much better, **shulker boxes full of
     elytras** (the bot cracks one open when it needs one). Ender-chest contents
     are global, so any ender chest works.
   - Keep some **fireworks**? Not needed — the bot uses mineflayer's built-in
     firework-boost math, no rockets consumed.
2. **Launch base** — a small **platform with a clear edge to walk off**, near the
   region you want to map. Set a `/home` on it (e.g. `/sethome spawn`) and put
   that name in `config.json` as `mapping.homeName`.

If your bed and launch platform are the same place, that works too — the mapper
just launches from where it respawns.

> ⚠️ Only map areas you're allowed to, and respect your server's rules. This is a
> bot that flies and reads terrain; it does not grief, raid, or attack.

---

## Configure

Edit `config.json` (copied from `config.example.json`). Secrets can also be
supplied via env vars, which override the file: `MAPPER_LOGIN_PASSWORD`,
`DISCORD_TOKEN`, `ARGUS_UPLOAD_TOKEN`. A `.env` file (`KEY=VALUE` lines) is loaded
if present.

| Field | Meaning |
|---|---|
| `account.auth` | `"offline"` (cracked) or `"microsoft"` (premium; first run prints a device-code link to sign in, then caches the token in `profilesFolder`). |
| `account.username` | The bot's Minecraft name. |
| `account.loginPassword` | For servers with AuthMe-style `/login` on offline accounts. Prefer the `MAPPER_LOGIN_PASSWORD` env var. |
| `server.host` / `port` / `version` | Server address and protocol version. |
| `server.directConnect` | `false` for 6b6t (does the proxy-lobby → portal walk). `true` for a normal server where you spawn straight onto the main world. |
| `server.lobbyBox` | *(optional)* `{minX,maxX,minZ,maxZ}` of the proxy lobby if your server's differs from 6b6t's. |
| `mapping.mode` | What to map (see **Modes** below). |
| `mapping.homeName` | The `/home` name of your launch platform. |
| `mapping.autoStart` | Start mapping automatically on connect (good for a VPS). |
| `output.dir` | Where tiles + `manifest.json` are written. |
| `discord.*` | Optional control bot — your own token + channel id. |
| `upload.*` | Your ARGUS instance URL + mod-upload token, used by `upload.js`. |

---

## Run

```bash
npm start          # or: node index.js
```

It connects, reaches the main server, and (if `autoStart`) begins mapping the
configured mode. Progress is logged to the console (and Discord, if enabled).

Leave it running. To keep it alive across crashes/reboots on a VPS, use a process
manager:

```bash
pm2 start index.js --name argus-mapper
# or a systemd service
```

---

## Discord control (optional)

Set `discord.enabled: true` with your **own** bot token and a channel id. In that
channel:

- `!map on [mode]` — start (or switch) mapping.
- `!map off` — stop.
- `!map status` — current state, coverage, position.

Modes: `spawn`, `ring`, `ring-nw|ne|se|sw`, `north|south|east|west|ne|nw|se|sw`,
`rotate`.

---

## Modes

- **`ring`** — fill the ±10k box around spawn, skipping the dodgy centre. The main
  "map as much of spawn as possible" mode.
- **`ring-nw` / `ring-ne` / `ring-se` / `ring-sw`** — one quadrant only. Set a
  `/home` inside that quadrant and map it efficiently, then move to the next.
- **`spawn`** — grid-fill ±5k through the centre (only where the centre is safe).
- **`north` … `nw`** — map along one compass highway out toward the world border.
- **`rotate`** — cycle through all eight highways, one elytra run each.

---

## Uploading to ARGUS

The mapper only writes tiles locally. To contribute them:

```bash
npm run upload     # or: node upload.js
```

This reads `output/manifest.json` and POSTs each tile to
`upload.argusUrl` + `/api/mod/upload-tile` using `upload.token`. It's paced under
the server's rate limit, and ARGUS de-dupes overlapping tiles, so re-running is
safe. Delete the `output/` folder to start fresh.

*(You need a valid mod-upload token from the ARGUS instance operator.)*

---

## Output format

```
output/
  tiles/tile_<cellX>_<cellZ>.png   # one PNG per ~112-block cell (newest wins)
  manifest.json                    # { "<cellX>_<cellZ>": { file, x, z, radius, pixelSize, timestamp } }
  mapper-state.json                # persisted on/off + mode, for resume
```

Each tile is a transparent-gapped top-down render centred on `(x, z)`, covering
`±radius` blocks at `pixelSize` px per block.

---

## Troubleshooting

- **"No config found"** — copy `config.example.json` to `config.json`.
- **Stuck in the lobby / never maps** — your server's proxy-lobby box differs;
  set `server.lobbyBox`, or `server.directConnect: true` for a normal server.
- **"Out of elytras"** — restock the ender chest, then `!map on` (or restart).
- **Auto-stopped after recovery /kills** — the bed/respawn was lost; re-sleep the
  bed at the far base.
- **Corrupt-chunk spam** — expected on 6b6t near certain builds; the bot logs
  "skipped an unparseable packet" and stays connected. Harmless.
- **Nothing renders / all transparent** — chunks aren't loading (view distance /
  server lag); it skips near-empty renders automatically.

---

## Tuning

Flight/mapping constants (cruise altitude, render radius, grid spacing, keep-out
radius, `/home` cooldown, etc.) are at the top of `lib/mapper.js`, each with a
comment explaining why it's set where it is. They're tuned for 6b6t; adjust for
your server if needed.

---

## License

MIT — see [LICENSE](LICENSE).
