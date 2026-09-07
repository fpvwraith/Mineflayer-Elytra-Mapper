// Loads and validates config.json. SECRETS are never hardcoded: they live in
// config.json (which is gitignored) and can also be supplied/overridden by
// environment variables, so you can keep them out of any file entirely:
//   MAPPER_LOGIN_PASSWORD   -> account.loginPassword (offline /login)
//   DISCORD_TOKEN           -> discord.token
//   ARGUS_UPLOAD_TOKEN      -> upload.token
// A minimal .env file (KEY=VALUE lines) next to index.js is also loaded if present.
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const p = path.join(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function loadConfig(file = path.join(process.cwd(), 'config.json')) {
  loadDotEnv();
  if (!fs.existsSync(file)) {
    console.error(`\nNo config found at ${file}.\nCopy config.example.json to config.json and fill it in.\n`);
    process.exit(1);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error(`config.json is not valid JSON: ${e.message}`); process.exit(1); }

  cfg.account = cfg.account || {};
  cfg.server = cfg.server || {};
  cfg.mapping = cfg.mapping || {};
  cfg.output = cfg.output || {};
  cfg.discord = cfg.discord || {};
  cfg.upload = cfg.upload || {};

  // Env overrides for secrets (win over the file).
  if (process.env.MAPPER_LOGIN_PASSWORD) cfg.account.loginPassword = process.env.MAPPER_LOGIN_PASSWORD;
  if (process.env.DISCORD_TOKEN) cfg.discord.token = process.env.DISCORD_TOKEN;
  if (process.env.ARGUS_UPLOAD_TOKEN) cfg.upload.token = process.env.ARGUS_UPLOAD_TOKEN;

  // Defaults.
  cfg.account.auth = cfg.account.auth || 'offline';
  cfg.account.profilesFolder = cfg.account.profilesFolder || './auth_cache';
  cfg.server.host = cfg.server.host || 'mc.6b6t.org';
  cfg.server.port = cfg.server.port || 25565;
  cfg.server.version = cfg.server.version || '1.21.11';
  cfg.server.directConnect = !!cfg.server.directConnect;
  cfg.mapping.mode = cfg.mapping.mode || 'ring';
  cfg.mapping.homeName = cfg.mapping.homeName || 'spawn';
  cfg.mapping.autoStart = cfg.mapping.autoStart !== false; // default true
  // A user-defined rectangle can be given as mode "box" + a box object; normalize
  // it to the internal "box:x1,z1,x2,z2" mode string the mapper understands.
  if (cfg.mapping.mode === 'box' && cfg.mapping.box) {
    const b = cfg.mapping.box;
    if ([b.x1, b.z1, b.x2, b.z2].every(n => Number.isFinite(n))) cfg.mapping.mode = `box:${b.x1},${b.z1},${b.x2},${b.z2}`;
  }
  cfg.output.dir = cfg.output.dir || './output';
  cfg.discord.enabled = !!cfg.discord.enabled;

  // Validation.
  const errors = [];
  if (!cfg.account.username) errors.push('account.username is required (your Minecraft account name).');
  if (cfg.account.auth !== 'offline' && cfg.account.auth !== 'microsoft') errors.push('account.auth must be "offline" or "microsoft".');
  if (cfg.account.auth === 'offline' && !cfg.account.loginPassword) console.warn('⚠️  account.auth is "offline" but no loginPassword set — set it (config or MAPPER_LOGIN_PASSWORD) if your server needs /login.');
  if (cfg.discord.enabled && (!cfg.discord.token || !cfg.discord.channelId)) errors.push('discord.enabled is true but discord.token and/or discord.channelId are missing.');
  if (cfg.mapping.mode === 'box') errors.push('mapping.mode is "box" but mapping.box must be {x1,z1,x2,z2} numbers, e.g. {"x1":1000,"z1":1000,"x2":-1000,"z2":-1000}.');
  if (errors.length) { console.error('Config errors:\n - ' + errors.join('\n - ')); process.exit(1); }

  return cfg;
}

module.exports = { loadConfig };
