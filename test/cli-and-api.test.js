'use strict';
// CLI boot checks (no server, no network) and the public library surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'argus-mapper.js');
const run = (file, args, opts = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', timeout: 30000, ...opts });

test('--help and --version', () => {
  const h = run(CLI, ['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage:/);
  assert.match(h.stdout, /--dry-run/);
  const v = run(CLI, ['--version']);
  assert.equal(v.stdout.trim(), require('../package.json').version);
});

test('--dry-run with the example config validates and prints the plan without connecting', () => {
  const dir = tmpDir();
  const r = run(CLI, ['--dry-run', '--config', path.join(ROOT, 'config.example.json')], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run/);
  assert.match(r.stdout, /Config is valid/);
  assert.match(r.stdout, /waypoints after guards/);
  assert.equal(fs.readdirSync(dir).length, 0, 'a dry run writes nothing');
  rmDir(dir);
});

test('a bad config exits 2 with readable messages and no stack trace', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ account: { username: '' }, mapping: { mode: 'nope' } }));
  const r = run(CLI, ['--dry-run'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /account\.username is required/);
  assert.match(r.stderr, /mapping\.mode "nope"/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
  const missing = run(CLI, ['--dry-run', '--config', path.join(dir, 'absent.json')], { cwd: dir });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No config found/);
  rmDir(dir);
});

test('status command reads the status file', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'st.json');
  fs.writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), connection: 'main', mapping: { state: 'idle', mode: 'box', active: false, covered: 0, waypoints: 4 } }));
  const r = run(CLI, ['status', '--file', f]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /connection : main/);
  const none = run(CLI, ['status', '--file', path.join(dir, 'none.json')]);
  assert.equal(none.status, 1);
  rmDir(dir);
});

test('library exports the documented API', () => {
  const L = require('..');
  for (const k of ['createMapper', 'createRegionWriter', 'planBox', 'neededRegions', 'parseNeeded', 'neededToBoxes', 'resolveConfig', 'columnFromPrismarine', 'encodeRegion', 'decodeRegion', 'regionAllowed', 'VERSION']) {
    assert.ok(L[k] !== undefined, k);
  }
  assert.equal(typeof L.createMapper, 'function');
  assert.equal(L.uploadRegions, undefined);
});

test('createMapper returns an EventEmitter with start/stop/status and writes status on stop (never connects here)', async () => {
  const dir = tmpDir();
  const { createMapper } = require('..');
  const m = createMapper({ account: { username: 'TestBot' }, output: { dir } }, { console: false });
  for (const fn of ['on', 'start', 'stop', 'status', 'startMapping', 'stopMapping']) assert.equal(typeof m[fn], 'function', fn);
  const s = m.status();
  assert.equal(s.connection, 'idle');
  assert.equal(s.account, 'TestBot');
  assert.equal(JSON.stringify(s).includes('password'), false);
  const events = [];
  m.on('state', (e) => events.push(e.connection));
  assert.match(await m.startMapping('boxes'), /mapping\.boxes is empty/);
  await m.stop();
  assert.ok(events.includes('stopped'));
  assert.ok(fs.existsSync(path.join(dir, 'status.json')));
  rmDir(dir);
});

test('needed mode: startMapping fetches boxes through the injected fetch, filters by the guards, and starts', async () => {
  const dir = tmpDir();
  const { createMapper } = require('..');
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ needed: [
    { regionX0: 100, regionZ0: 40, regionX1: 101, regionZ1: 41, blockX0: 51200, blockZ0: 20480, blockX1: 52224, blockZ1: 21504, ring: 50, isBounty: false },
    { regionX0: 0, regionZ0: 0, regionX1: 1, regionZ1: 1, ring: 0 },
  ] }) });
  const m = createMapper({ account: { username: 'TestBot' }, output: { dir } }, { console: false, fetchImpl });
  assert.match(await m.startMapping('needed'), /started \(needed\)/);
  const st = m.status().mapping;
  assert.ok(st.waypoints > 30, `waypoints ${st.waypoints}`);
  assert.equal(m.mapper.status().mode, 'needed');
  await m.stop();
  rmDir(dir);
});
