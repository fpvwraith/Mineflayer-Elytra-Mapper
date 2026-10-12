'use strict';
// Config loading and validation. No secrets live in the repo: use config.json (gitignored), a .env file or
// environment variables. resolveConfig() is pure (no process.exit, no console), so embedders can call it too.
//
// Environment overrides (win over the file):
//   MAPPER_LOGIN_PASSWORD -> account.loginPassword     DISCORD_TOKEN -> discord.token
const fs = require('fs');
const path = require('path');
const { normalizeDimension } = require('./regions');

class ConfigError extends Error {
  constructor(errors) {
    super('Invalid config:\n - ' + errors.join('\n - '));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const FIXED_MODES = ['spawn', 'ring', 'north', 'south', 'east', 'west', 'ne', 'nw', 'se', 'sw', 'rotate', 'box', 'boxes', 'needed'];

const DEFAULTS = {
  account: { auth: 'offline', username: '', loginPassword: '', profilesFolder: './auth_cache' },
  server: { host: 'mc.6b6t.org', port: 25565, version: '1.21.11', directConnect: false, lobbyBox: null, viewDistance: null },
  mapping: {
    mode: 'ring', box: null, boxes: [], homeName: 'spawn', autoStart: true,
    noHomeRadius: 5000, homeCooldownSec: 315, skipSpawnRegions: true,
    neededUrl: 'https://map.argus.tools', neededLimit: 40, neededRefreshMin: 30,
  },
  limits: { maxAbsBlock: 150000 },
  output: { dir: './output', dimension: 'overworld', regions: true, tiles: false, flushIdleSec: 60, evictIdleSec: 300 },
  memory: { pruneChunks: true, keepChunks: 18, pruneEverySec: 5 },
  connection: { reconnectBaseSec: 15, reconnectMaxSec: 300, rateLimitCooldownSec: 45, captchaCooldownMin: 60 },
  status: { file: 'status.json', intervalSec: 10 },
  log: { level: 'info', format: 'text', file: null },
  discord: { enabled: false, token: '', channelId: '' },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (isObj(over[k]) && isObj(base[k])) out[k] = deepMerge(base[k], over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}

// Parse "KEY=VALUE" lines (no export, no multi-line values); returns an object.
function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

// Normalise one box in any accepted shape to [x1,z1,x2,z2], or null.
function toBoxArray(b) {
  const a = Array.isArray(b) ? b : isObj(b) ? [b.x1, b.z1, b.x2, b.z2] : null;
  if (!a || a.length !== 4 || !a.every((n) => Number.isFinite(n))) return null;
  return a;
}

/**
 * Merge defaults, file/object config and env, then validate.
 * @param {object} input   the raw config (parsed config.json or an object you built)
 * @param {{env?: object}} [opts]  environment to read overrides from (default process.env)
 * @returns {{config: object, warnings: string[]}}
 * @throws {ConfigError} with .errors (array of readable messages)
 */
function resolveConfig(input, opts = {}) {
  const env = opts.env || process.env;
  const raw = isObj(input) ? input : {};
  const warnings = [];
  const errors = [];
  const cfg = deepMerge(DEFAULTS, raw);

  if (env.MAPPER_LOGIN_PASSWORD) cfg.account.loginPassword = env.MAPPER_LOGIN_PASSWORD;
  if (env.DISCORD_TOKEN) cfg.discord.token = env.DISCORD_TOKEN;

  const num = (name, v, { min = -Infinity, max = Infinity, int = false } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      errors.push(`${name} must be ${int ? 'an integer' : 'a number'}${min > -Infinity ? ` >= ${min}` : ''}${max < Infinity ? ` and <= ${max}` : ''} (got ${JSON.stringify(v)}).`);
    }
  };
  const bool = (name, v) => { if (typeof v !== 'boolean') errors.push(`${name} must be true or false (got ${JSON.stringify(v)}).`); };
  const str = (name, v) => { if (typeof v !== 'string' || !v) errors.push(`${name} must be a non-empty string.`); };

  // account / server
  if (!cfg.account.username || typeof cfg.account.username !== 'string') errors.push('account.username is required (the Minecraft account name the bot logs in as).');
  if (!['offline', 'microsoft'].includes(cfg.account.auth)) errors.push('account.auth must be "offline" or "microsoft".');
  if (cfg.account.auth === 'offline' && !cfg.account.loginPassword) warnings.push('account.auth is "offline" and no loginPassword is set - set it (or MAPPER_LOGIN_PASSWORD) if your server needs /login.');
  str('server.host', cfg.server.host); num('server.port', cfg.server.port, { min: 1, max: 65535, int: true }); str('server.version', cfg.server.version);
  bool('server.directConnect', cfg.server.directConnect);
  if (cfg.server.lobbyBox !== null) {
    const l = cfg.server.lobbyBox;
    if (!isObj(l) || !['minX', 'maxX', 'minZ', 'maxZ'].every((k) => Number.isFinite(l[k]))) errors.push('server.lobbyBox must be {minX,maxX,minZ,maxZ} numbers (or null for the 6b6t default).');
  }
  if (cfg.server.viewDistance !== null) num('server.viewDistance', cfg.server.viewDistance, { min: 2, max: 32, int: true });

  // mapping
  const m = cfg.mapping;
  const modeOk = typeof m.mode === 'string' && (FIXED_MODES.includes(m.mode) || /^ring-(nw|ne|se|sw)$/.test(m.mode) || /^box:-?\d+,-?\d+,-?\d+,-?\d+$/.test(m.mode));
  if (!modeOk) errors.push(`mapping.mode "${m.mode}" is not valid. Use one of: ${FIXED_MODES.join(', ')}, ring-nw|ne|se|sw, or box:x1,z1,x2,z2.`);
  if (m.mode === 'box') {
    const b = toBoxArray(m.box);
    if (!b) errors.push('mapping.mode is "box" but mapping.box must be {x1,z1,x2,z2} numbers, e.g. {"x1":20000,"z1":20000,"x2":30000,"z2":30000}.');
    else m.mode = `box:${b.join(',')}`;
  }
  if (!Array.isArray(m.boxes)) errors.push('mapping.boxes must be a list of boxes ({x1,z1,x2,z2} or [x1,z1,x2,z2]).');
  else {
    const fixed = m.boxes.map(toBoxArray);
    if (fixed.some((b) => !b)) errors.push('mapping.boxes: every entry must be {x1,z1,x2,z2} or [x1,z1,x2,z2] with finite numbers.');
    else m.boxes = fixed;
    if (m.mode === 'boxes' && !m.boxes.length) errors.push('mapping.mode is "boxes" but mapping.boxes is empty.');
  }
  str('mapping.homeName', m.homeName); bool('mapping.autoStart', m.autoStart);
  num('mapping.noHomeRadius', m.noHomeRadius, { min: 0 }); num('mapping.homeCooldownSec', m.homeCooldownSec, { min: 0 });
  bool('mapping.skipSpawnRegions', m.skipSpawnRegions);
  str('mapping.neededUrl', m.neededUrl);
  if (typeof m.neededUrl === 'string' && m.neededUrl && !/^https?:\/\//i.test(m.neededUrl)) errors.push('mapping.neededUrl must start with http:// or https://');
  num('mapping.neededLimit', m.neededLimit, { min: 1, max: 500, int: true }); num('mapping.neededRefreshMin', m.neededRefreshMin, { min: 1 });

  // limits
  num('limits.maxAbsBlock', cfg.limits.maxAbsBlock, { min: 1024, max: 30000000 });

  // output
  const o = cfg.output;
  str('output.dir', o.dir);
  const dim = normalizeDimension(o.dimension);
  if (!dim) errors.push('output.dimension must be overworld, nether or end.'); else o.dimension = dim;
  bool('output.regions', o.regions); bool('output.tiles', o.tiles);
  if (o.regions === false && o.tiles === false) errors.push('output.regions and output.tiles are both false - nothing would be saved.');
  num('output.flushIdleSec', o.flushIdleSec, { min: 5 }); num('output.evictIdleSec', o.evictIdleSec, { min: 10 });
  if (o.evictIdleSec < o.flushIdleSec) errors.push('output.evictIdleSec must be >= output.flushIdleSec.');

  // memory / connection
  bool('memory.pruneChunks', cfg.memory.pruneChunks);
  num('memory.keepChunks', cfg.memory.keepChunks, { min: 8, max: 64, int: true }); num('memory.pruneEverySec', cfg.memory.pruneEverySec, { min: 1 });
  const c = cfg.connection;
  num('connection.reconnectBaseSec', c.reconnectBaseSec, { min: 1 }); num('connection.reconnectMaxSec', c.reconnectMaxSec, { min: 1 });
  num('connection.rateLimitCooldownSec', c.rateLimitCooldownSec, { min: 0 }); num('connection.captchaCooldownMin', c.captchaCooldownMin, { min: 0 });
  if (c.reconnectMaxSec < c.reconnectBaseSec) errors.push('connection.reconnectMaxSec must be >= connection.reconnectBaseSec.');

  // status / log / discord
  str('status.file', cfg.status.file); num('status.intervalSec', cfg.status.intervalSec, { min: 1 });
  if (!['error', 'warn', 'info', 'debug'].includes(cfg.log.level)) errors.push('log.level must be error, warn, info or debug.');
  if (!['text', 'json'].includes(cfg.log.format)) errors.push('log.format must be "text" or "json".');
  bool('discord.enabled', cfg.discord.enabled);
  if (cfg.discord.enabled === true && (!cfg.discord.token || !cfg.discord.channelId)) errors.push('discord.enabled is true but discord.token and/or discord.channelId are missing.');

  if (errors.length) throw new ConfigError(errors);
  return { config: cfg, warnings };
}

// CLI helper: read config.json (and a .env next to it / in the working directory), then resolveConfig.
function loadConfigFile(file = path.join(process.cwd(), 'config.json'), opts = {}) {
  const env = { ...process.env };
  for (const dir of new Set([process.cwd(), path.dirname(path.resolve(file))])) {
    const p = path.join(dir, '.env');
    if (fs.existsSync(p)) for (const [k, v] of Object.entries(parseDotEnv(fs.readFileSync(p, 'utf8')))) if (env[k] === undefined) env[k] = v;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') throw new ConfigError([`No config found at ${file}. Copy config.example.json to config.json and fill it in.`]);
    else throw new ConfigError([`${file} is not valid JSON: ${e.message}`]);
  }
  return resolveConfig(raw, { env });
}

module.exports = { resolveConfig, loadConfigFile, parseDotEnv, ConfigError, DEFAULTS, FIXED_MODES };
