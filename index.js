#!/usr/bin/env node
// ARGUS Mapper — a standalone, self-hostable autonomous elytra terrain mapper.
// Flies your Minecraft account around spawn, renders the terrain to PNG tiles in
// an output folder, and (via upload.js) contributes them to an ARGUS community
// map. Config-driven; no secrets in the repo. See README.md for setup.
const path = require('path');
const Vec3 = require('vec3');

const { loadConfig } = require('./lib/config');
const { createOutput } = require('./lib/output');
const { createConnection } = require('./lib/connection');
const { createSpawnMapper } = require('./lib/mapper');
const { generateMappingRender } = require('./lib/render');

const config = loadConfig();
const outputDir = path.resolve(config.output.dir);

// ---- logging (console always; optional Discord mirror) --------------------
let discord = null;
function log(msg) {
  console.log(typeof msg === 'string' ? msg : String(msg));
  if (discord) { try { discord.log(msg); } catch (e) {} }
}

// ---- output (flat tiles + manifest) ---------------------------------------
const output = createOutput(outputDir);

// ---- the mapper (getBot is resolved lazily from the connection below) -----
let connection = null;
const mapper = createSpawnMapper({
  getBot: () => (connection ? connection.getBot() : null),
  sendLog: log,
  Vec3,
  renderMappingPng: (bot, radius) => {
    const p = bot.entity.position;
    return generateMappingRender(bot, Math.round(p.x), Math.round(p.z), radius);
  },
  saveTile: output.saveTile,
  loadCoveredCells: output.loadCoveredCells,
  canRun: () => true, // no honeypot/personal-TP in the standalone; `!map off` stops it
  stateFile: path.join(outputDir, 'mapper-state.json'),
  mapConfig: { homeName: config.mapping.homeName },
});

// ---- auto-start / resume on reaching the main server ----------------------
let autoStartedOnce = false;
function onMainServer() {
  if (mapper.isActive()) return;
  setTimeout(() => {
    if (!connection || !connection.isOnMainServer() || mapper.isActive()) return;
    const persisted = mapper.wasEnabled(); // { enabled, mode, rotating }
    if (persisted.enabled) {
      // It was running when the process/connection last went down — resume it.
      log(`🗺️ resuming previous mapping run: ${mapper.start(persisted.rotating ? 'rotate' : persisted.mode)}`);
    } else if (!autoStartedOnce && config.mapping.autoStart) {
      autoStartedOnce = true;
      log(`🗺️ auto-starting mapping (mode ${config.mapping.mode}): ${mapper.start(config.mapping.mode)}`);
    }
  }, 8000); // let the bot settle on the main server before it starts flying
}

// ---- connection (creates + keeps the bot on the main server) --------------
connection = createConnection({
  config,
  log,
  onDeath: () => { try { mapper.onDeath(); } catch (e) {} },
  onMainServer,
});

// ---- optional Discord control --------------------------------------------
if (config.discord.enabled) {
  const { createDiscord } = require('./lib/discord');
  discord = createDiscord({ token: config.discord.token, channelId: config.discord.channelId }, {
    onCommand: (sub, arg, reply) => {
      if (sub === 'on') {
        // Accept `!map on box 1000 1000 -1000 -1000` or `box:1000,1000,-1000,-1000`.
        let mode = arg || config.mapping.mode;
        const bm = mode.match(/^box[:\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i);
        if (bm) mode = `box:${bm[1]},${bm[2]},${bm[3]},${bm[4]}`;
        reply(mapper.start(mode));
      }
      else if (sub === 'off') { reply(mapper.stop()); }
      else if (sub === 'status') {
        const s = mapper.status();
        reply(`state=${s.state} mode=${s.mode} active=${s.active} covered=${s.covered}/${s.waypoints} tilesThisSession=${s.tilesThisSession} pos=${s.pos ? `${s.pos.x},${s.pos.z}` : '?'}${s.lastError ? ` lastError=${s.lastError}` : ''}`);
      } else {
        reply('commands: `!map on [mode]`, `!map off`, `!map status`\nmodes: spawn | ring | ring-nw|ne|se|sw | north/south/east/west/ne/nw/se/sw | rotate | box\nbox example: `!map on box 1000 1000 -1000 -1000` (maps that square)');
      }
    },
  });
  discord.start();
}

// ---- process-level safety net --------------------------------------------
// A stray unhandled rejection is logged and swallowed (usually a benign
// transient); an uncaught exception is logged then the process exits so a
// supervisor (pm2/systemd) restarts it cleanly rather than limping on.
process.on('unhandledRejection', (reason) => log(`⚠️ unhandled rejection (continuing): ${reason && reason.message ? reason.message : reason}`));
process.on('uncaughtException', (err) => { console.error(`[FATAL] uncaught exception: ${err && err.stack ? err.stack : err}`); setTimeout(() => process.exit(1), 500); });

log('==================================================');
log(`ARGUS Mapper starting — account "${config.account.username}", output "${outputDir}"`);
log(`mode=${config.mapping.mode} home=/${'home ' + config.mapping.homeName} autoStart=${config.mapping.autoStart} discord=${config.discord.enabled}`);
log('==================================================');
connection.start();
