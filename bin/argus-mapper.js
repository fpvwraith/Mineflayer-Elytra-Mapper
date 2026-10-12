#!/usr/bin/env node
'use strict';
// argus-mapper: command line front end of argus-elytra-mapper.
//   argus-mapper [run]      start the mapper (default)         --config FILE  --mode MODE  --dry-run
//   argus-mapper status     print the status snapshot          --config FILE  --json
//   argus-mapper needed     list areas the community map lacks --limit N  --url URL
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');

const HELP = `argus-mapper ${pkg.version}
Autonomous elytra terrain mapper. Flies a bot and saves Xaero World Map compatible region files locally.

Usage:
  argus-mapper [run] [options]     start mapping (reads ./config.json)
  argus-mapper status [options]    show the live status snapshot of a running mapper
  argus-mapper needed [options]    (optional) list areas a public ARGUS community map still lacks, read-only

Options:
  --config FILE      config file (default ./config.json)
  --mode MODE        override mapping.mode (spawn, ring, ring-nw, north, ..., rotate, box:x1,z1,x2,z2, boxes, needed)
  --dry-run          check the config, print what would happen, do not connect or write anything
  --json             (status) print raw JSON
  --limit N          (needed) how many areas to fetch (default 20)
  --url URL          (needed) base URL of the list (default mapping.neededUrl or https://map.argus.tools)
  -h, --help         this help
  -v, --version      print the version

Docs: README.md and docs/ in the package.`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.flags.help = true;
    else if (a === '-v' || a === '--version') out.flags.version = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out.flags[k] = v;
      else if (['dry-run', 'json'].includes(k)) out.flags[k] = true;
      else { out.flags[k] = argv[i + 1]; i++; }
    } else out._.push(a);
  }
  return out;
}

async function main(argv) {
  const { _, flags } = parseArgs(argv);
  if (flags.version) { console.log(pkg.version); return 0; }
  const cmd = _[0] || 'run';
  if (flags.help || cmd === 'help') { console.log(HELP); return 0; }

  const { loadConfigFile, ConfigError } = require('../lib/config');
  const configFile = path.resolve(flags.config || 'config.json');

  if (cmd === 'needed') {
    const { neededRegions, neededToBoxes } = require('../lib/planner');
    let url = flags.url;
    if (!url) { try { url = loadConfigFile(configFile).config.mapping.neededUrl; } catch (e) { /* no config: use the default */ } }
    const parsed = await neededRegions({ url, limit: Number(flags.limit) || 20 });
    const boxes = neededToBoxes(parsed);
    console.log(`${parsed.cells.length} area(s) needed (${parsed.dimension}), ${boxes.length} usable after the spawn/limit guards:`);
    for (const c of parsed.cells) console.log(`  ring ${c.ring}  regions ${c.regionX0},${c.regionZ0} .. ${c.regionX1},${c.regionZ1}  blocks ${c.blockX0},${c.blockZ0} .. ${c.blockX1},${c.blockZ1}${c.isBounty ? '  (bounty)' : ''}`);
    return 0;
  }

  if (cmd === 'status') {
    const { readStatusFile, formatStatus } = require('../lib/status');
    let file = flags.file;
    if (!file) {
      const { config } = loadConfigFile(configFile);
      const dir = path.resolve(config.output.dir);
      file = path.isAbsolute(config.status.file) ? config.status.file : path.join(dir, config.status.file);
    }
    const s = readStatusFile(file);
    console.log(flags.json ? JSON.stringify(s, null, 2) : formatStatus(s));
    return s ? 0 : 1;
  }

  if (cmd !== 'run') { console.error(`Unknown command "${cmd}". Try --help.`); return 2; }

  let loaded;
  try { loaded = loadConfigFile(configFile); }
  catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); return 2; }
    throw e;
  }
  const { config, warnings } = loaded;
  if (flags.mode) {
    const { resolveConfig } = require('../lib/config');
    try { Object.assign(config.mapping, resolveConfig({ ...config, mapping: { ...config.mapping, mode: flags.mode } }).config.mapping); }
    catch (e) { console.error(e.message); return 2; }
  }
  if (flags['dry-run']) { for (const w of warnings) console.warn(`warning: ${w}`); return dryRun(config); }

  const { createMapper } = require('../lib');
  const mapper = createMapper(config);

  // Graceful shutdown: flush regions, write coverage + status, then exit. A second signal forces exit.
  let closing = false;
  const shutdown = (sig) => {
    if (closing) process.exit(130);
    closing = true;
    console.log(`\n${sig} received: flushing regions and shutting down (press again to force)...`);
    mapper.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (r) => console.error(`unhandled rejection (continuing): ${r && r.message ? r.message : r}`));
  // An uncaught exception is logged, regions are flushed, then the process exits so a supervisor can restart it.
  process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaught exception: ${err && err.stack ? err.stack : err}`);
    mapper.stop().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
  });

  await mapper.start();
  return null; // keep running
}

function dryRun(config) {
  const { planBox } = require('../lib/planner');
  const { regionAllowed } = require('../lib/regions');
  const guard = { skipSpawnRegions: config.mapping.skipSpawnRegions, maxAbsBlock: config.limits.maxAbsBlock };
  const out = path.resolve(config.output.dir);
  console.log('Dry run: nothing is connected or written.\n');
  console.log(`account        : ${config.account.username} (${config.account.auth})`);
  console.log(`server         : ${config.server.host}:${config.server.port}, version ${config.server.version}${config.server.directConnect ? ', direct connect' : ', proxy-lobby handling on'}`);
  console.log(`mode           : ${config.mapping.mode}  autoStart=${config.mapping.autoStart}`);
  console.log(`output         : ${out}  (regions=${config.output.regions}, tiles=${config.output.tiles}, dimension=${config.output.dimension})`);
  console.log(`guards         : skipSpawnRegions=${guard.skipSpawnRegions}, maxAbsBlock=${guard.maxAbsBlock}`);
  console.log(`memory         : pruneChunks=${config.memory.pruneChunks} keepChunks=${config.memory.keepChunks} viewDistance=${config.server.viewDistance || 'server default'}`);
  console.log(`captcha kicks  : ${config.connection.captchaCooldownMin > 0 ? `wait ${config.connection.captchaCooldownMin} min, then reconnect` : 'stop and wait for the operator'} (never solved by the mapper)`);
  try {
    let boxes = null;
    if (config.mapping.mode.startsWith('box:')) boxes = [config.mapping.mode.slice(4).split(',').map(Number)];
    else if (config.mapping.mode === 'boxes') boxes = config.mapping.boxes;
    if (boxes) {
      let n = 0;
      for (const b of boxes) n += planBox(b, guard).length;
      console.log(`plan           : ${boxes.length} box(es) -> ${n} waypoints after guards`);
    } else if (config.mapping.mode === 'needed') {
      console.log(`plan           : fetches ${config.mapping.neededLimit} areas from ${config.mapping.neededUrl}/api/needed-regions (read-only) when mapping starts; not fetched in a dry run`);
    } else {
      console.log('plan           : built-in mode, waypoints are generated when mapping starts');
    }
  } catch (e) { console.log(`plan           : ${e.message}`); }
  const rdir = path.join(out, 'regions', config.output.dimension);
  let existing = 0, wouldSend = 0;
  try {
    for (const n of fs.readdirSync(rdir)) { const m = /^(-?\d+)_(-?\d+)\.zip$/.exec(n); if (m) { existing++; if (regionAllowed(+m[1], +m[2], guard)) wouldSend++; } }
  } catch (e) { /* no output yet */ }
  console.log(`existing output: ${existing} region file(s) in ${rdir}, ${wouldSend} inside the guards`);
  console.log('\nConfig is valid.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { if (code !== null && code !== undefined) process.exit(code); }, (e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
}
module.exports = { main, parseArgs };
