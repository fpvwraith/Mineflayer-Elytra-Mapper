'use strict';
// createMapper(config): the embeddable mapper. Wires the connection manager, the flight/mapping state machine,
// the chunk recorder + Xaero region writer, optional PNG tiles and the status file.
//
//   const mapper = createMapper({ account: { username: 'MyBot' }, server: { host: 'mc.example.org' } });
//   mapper.on('region', (r) => console.log('wrote', r.file));
//   await mapper.start();
//   ...
//   await mapper.stop();
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const Vec3 = require('vec3');

const { resolveConfig } = require('./config');
const { createLogger } = require('./logger');
const { createOutput } = require('./output');
const { createConnection } = require('./connection');
const { createSpawnMapper } = require('./mapper');
const { createRecorder } = require('./recorder');
const { attachChunkPrune } = require('./chunk-prune');
const { createWriter } = require('./xaero-writer');
const { writeStatusFile } = require('./status');
const { neededRegions, neededToBoxes } = require('./planner');
const { regionAllowed, blockAllowed } = require('./regions');
const { writeJsonAtomic } = require('./json-store');

const RENDER_RADIUS_BLOCKS = 56; // must equal RENDER_RADIUS in lib/mapper.js

function createMapper(userConfig = {}, opts = {}) {
  const { config, warnings } = resolveConfig(userConfig, { env: opts.env });
  const emitter = new EventEmitter();
  const outputDir = path.resolve(config.output.dir);
  fs.mkdirSync(outputDir, { recursive: true });

  // ---- logging -----------------------------------------------------------
  const secrets = [config.account.loginPassword, config.discord.token];
  const logger = createLogger({
    level: config.log.level, format: config.log.format, file: config.log.file ? path.resolve(config.log.file) : null,
    secrets, console: opts.console !== false,
    sink: (entry) => { emitter.emit('log', entry); },
  });
  let discord = null;
  const log = (msg) => {
    const text = typeof msg === 'string' ? msg : String(msg);
    logger.line(text);
    if (discord) { try { discord.log(logger.scrub(text)); } catch (e) { /* ignore */ } }
  };
  for (const w of warnings) logger.warn(w);

  // ---- output + writer + recorder ---------------------------------------
  const guard = { skipSpawnRegions: config.mapping.skipSpawnRegions, maxAbsBlock: config.limits.maxAbsBlock };
  const output = createOutput(outputDir, { tiles: config.output.tiles, dimension: config.output.dimension });
  const writer = config.output.regions ? createWriter({ outDir: output.regionsDir, dimension: config.output.dimension }) : null;

  let connection = null;
  let connState = 'idle';
  let lastKick = null;
  let lastError = null;
  let started = false;

  const recorder = writer ? createRecorder({
    writer, guard, dimension: config.output.dimension, log,
    canRecord: () => !!(connection && connection.isOnMainServer()),
    flushIdleMs: config.output.flushIdleSec * 1000, evictIdleMs: config.output.evictIdleSec * 1000,
    onChunk: (c) => { if (emitter.listenerCount('chunk')) emitter.emit('chunk', c); },
    onRegion: (r) => emitter.emit('region', r),
  }) : null;

  // ---- target boxes for the 'boxes' / 'needed' modes --------------------
  let neededBoxes = [];
  let neededAt = 0;
  async function refreshNeeded() {
    try {
      const parsed = await neededRegions({ url: config.mapping.neededUrl, limit: config.mapping.neededLimit, fetchImpl: opts.fetchImpl });
      neededBoxes = neededToBoxes(parsed, { ...guard, maxCells: config.mapping.neededLimit });
      neededAt = Date.now();
      log(`needed-regions: ${neededBoxes.length} area(s) the community map still lacks`);
      return neededBoxes.length;
    } catch (e) {
      lastError = `needed-regions failed: ${e.message}`;
      log(`⚠️ ${lastError}`);
      return 0;
    }
  }
  const getTargetBoxes = (mode) => (mode === 'needed' ? neededBoxes : config.mapping.boxes);

  // ---- the flight state machine -----------------------------------------
  const mapper = createSpawnMapper({
    getBot: () => (connection ? connection.getBot() : null),
    sendLog: log,
    debugLog: (m) => logger.debug(String(m)),
    Vec3,
    renderMappingPng: (bot, radius) => {
      const p = bot.entity.position;
      const cx = Math.round(p.x), cz = Math.round(p.z);
      if (config.output.tiles) return require('./render').generateMappingRender(bot, cx, cz, radius);
      // No PNG tiles: only measure how much of the footprint has loaded, so coverage logic keeps working.
      const c0x = (cx - radius) >> 4, c1x = (cx + radius) >> 4, c0z = (cz - radius) >> 4, c1z = (cz + radius) >> 4;
      let found = 0, total = 0;
      for (let x = c0x; x <= c1x; x++) for (let z = c0z; z <= c1z; z++) { total++; if (bot.world.getColumn(x, z)) found++; }
      return { pngBuffer: null, centerX: cx, centerZ: cz, radius, span: radius * 2 + 1, pixelSize: 0, found, total };
    },
    saveTile: output.saveTile,
    loadCoveredCells: output.loadCoveredCells,
    canRun: () => true,
    stateFile: path.join(outputDir, 'mapper-state.json'),
    getTargetBoxes,
    waypointFilter: (x, z) => blockAllowed(x, z, guard),
    mapConfig: { homeName: config.mapping.homeName, noHomeRadius: config.mapping.noHomeRadius, homeCooldownSec: config.mapping.homeCooldownSec },
  });

  // ---- mode handling ------------------------------------------------------
  async function startMapping(mode = config.mapping.mode) {
    mode = String(mode).toLowerCase();
    if (mode === 'needed') {
      const n = await refreshNeeded();
      if (!n) return 'needed mode: no areas received (check the log); not started';
    } else if (mode === 'boxes' && !config.mapping.boxes.length) return 'boxes mode: mapping.boxes is empty';
    const res = mapper.start(mode);
    emitState();
    return res;
  }
  function stopMapping() { const r = mapper.stop(); emitState(); return r; }

  // ---- auto start / resume once on the main server -------------------------
  let autoStartedOnce = false;
  function onMainServer() {
    if (mapper.isActive()) return;
    setTimeout(async () => {
      if (!connection || !connection.isOnMainServer() || mapper.isActive()) return;
      const persisted = mapper.wasEnabled();
      if (persisted.enabled) {
        const mode = persisted.rotating ? 'rotate' : persisted.mode;
        log(`🗺️ resuming previous mapping run: ${await startMapping(mode)}`);
      } else if (!autoStartedOnce && config.mapping.autoStart) {
        autoStartedOnce = true;
        log(`🗺️ auto-starting mapping (mode ${config.mapping.mode}): ${await startMapping(config.mapping.mode)}`);
      }
    }, 8000); // let the bot settle on the main server before it starts flying
  }

  // ---- connection ----------------------------------------------------------
  connection = createConnection({
    config, log,
    onDeath: () => { try { mapper.onDeath(); } catch (e) { /* ignore */ } },
    onMainServer,
    hooks: {
      onBot: (bot) => {
        if (recorder) recorder.attach(bot);
        if (config.memory.pruneChunks) attachChunkPrune(bot, log, { keep: config.memory.keepChunks, everyMs: config.memory.pruneEverySec * 1000 });
      },
      onKick: (k) => { lastKick = { ...k, at: new Date().toISOString() }; emitter.emit('kicked', k); },
      onState: (name, detail) => { connState = name; emitState(detail); },
    },
  });

  function emitState(detail) {
    emitter.emit('state', { connection: connState, mapping: mapper.status(), detail: detail || null });
  }

  // ---- status snapshot -------------------------------------------------------
  function status() {
    const mem = process.memoryUsage();
    return {
      updatedAt: new Date().toISOString(),
      account: config.account.username,
      connection: connState,
      kick: lastKick,
      mapping: mapper.status(),
      recorder: recorder ? recorder.stats() : null,
      output: { dir: outputDir, regionsDir: output.regionsDir, regionFiles: output.regionFileCount(), tiles: config.output.tiles ? output.count() : 0 },
      memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
      lastError,
    };
  }
  const statusFile = path.isAbsolute(config.status.file) ? config.status.file : path.join(outputDir, config.status.file);
  function writeStatus() { try { writeStatusFile(statusFile, status()); } catch (e) { /* non-fatal */ } }

  // ---- lifecycle -------------------------------------------------------------
  const timers = [];
  async function start() {
    if (started) return;
    started = true;
    log(`argus-elytra-mapper starting: account "${config.account.username}", output "${outputDir}", mode ${config.mapping.mode}, regions=${config.output.regions} tiles=${config.output.tiles}`);
    if (config.discord.enabled) {
      const { createDiscord } = require('./discord');
      discord = createDiscord({ token: config.discord.token, channelId: config.discord.channelId }, {
        onCommand: async (sub, arg, reply) => {
          if (sub === 'on') {
            let mode = arg || config.mapping.mode;
            const bm = mode.match(/^box[:\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i);
            if (bm) mode = `box:${bm[1]},${bm[2]},${bm[3]},${bm[4]}`;
            reply(await startMapping(mode));
          } else if (sub === 'off') reply(stopMapping());
          else if (sub === 'status') {
            const s = mapper.status();
            reply(`state=${s.state} mode=${s.mode} active=${s.active} covered=${s.covered}/${s.waypoints} pos=${s.pos ? `${s.pos.x},${s.pos.z}` : '?'}${s.lastError ? ` lastError=${s.lastError}` : ''}`);
          } else reply('commands: `!map on [mode]`, `!map off`, `!map status`\nmodes: spawn | ring | ring-nw|ne|se|sw | north/south/east/west/ne/nw/se/sw | rotate | box | boxes | needed');
        },
      });
      discord.start();
    }
    timers.push(setInterval(writeStatus, config.status.intervalSec * 1000));
    timers.push(setInterval(() => output.saveCoverage(), 60000));
    if (config.mapping.mode === 'needed') timers.push(setInterval(() => { if (Date.now() - neededAt > config.mapping.neededRefreshMin * 60000) refreshNeeded(); }, 60000));
    for (const t of timers) if (t.unref) t.unref();
    writeStatus();
    connection.start();
  }

  let stopping = null;
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      log('stopping: flushing regions...');
      for (const t of timers) clearInterval(t);
      try { mapper.suspend(); } catch (e) { /* ignore */ }
      try { connection.stop(); } catch (e) { /* ignore */ }
      if (recorder) await recorder.close();
      output.saveCoverage();
      connState = 'stopped';
      writeStatus();
      emitState();
      logger.close();
      started = false;
    })();
    return stopping;
  }

  return Object.assign(emitter, {
    config, start, stop, status,
    startMapping, stopMapping, refreshNeeded,
    getBot: () => connection.getBot(),
    writer, mapper,
    // test hooks
    _recorder: recorder,
  });
}

module.exports = { createMapper };
