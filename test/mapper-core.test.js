'use strict';
// The flight state machine without a server: waypoint building for the box / boxes / needed modes with the guards,
// persisted state, suspend. Plus connection helpers (kick text), logger, status.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const { tmpDir, rmDir } = require('./helpers');
const { createSpawnMapper } = require('../lib/mapper');
const { blockAllowed } = require('../lib/regions');
const { kickText, classifyKick } = require('../lib/connection');
const { createLogger } = require('../lib/logger');
const { formatStatus, writeStatusFile, readStatusFile } = require('../lib/status');
const { createOutput } = require('../lib/output');

function makeMapper(dir, extra = {}) {
  const logs = [];
  const m = createSpawnMapper({
    getBot: () => null, sendLog: (l) => logs.push(l), Vec3,
    renderMappingPng: () => null, saveTile: () => {}, loadCoveredCells: () => [],
    stateFile: path.join(dir, 'mapper-state.json'),
    waypointFilter: (x, z) => blockAllowed(x, z, {}),
    getTargetBoxes: () => [],
    mapConfig: { homeName: 'spawn' },
    ...extra,
  });
  return { m, logs };
}

test('box mode builds waypoints inside the box and persists enabled/mode; stop clears it; suspend keeps it', () => {
  const dir = tmpDir();
  const { m } = makeMapper(dir);
  assert.equal(m.start('box:20000,20000,21000,21000'), 'started (box:20000,20000,21000,21000)');
  const st = m.status();
  assert.equal(st.mode, 'box:20000,20000,21000,21000');
  assert.ok(st.waypoints > 50 && st.waypoints < 200, `waypoints ${st.waypoints}`);
  assert.deepEqual(m.wasEnabled(), { enabled: true, mode: 'box:20000,20000,21000,21000', rotating: false, rotateSet: null });
  m.suspend();
  assert.equal(m.isActive(), false);
  assert.equal(m.wasEnabled().enabled, true, 'suspend keeps the resume flag');
  m.start('box:20000,20000,21000,21000');
  m.stop();
  assert.equal(m.wasEnabled().enabled, false);
  rmDir(dir);
});

test('a box over the lobby area loses the guarded waypoints', () => {
  const dir = tmpDir();
  const { m } = makeMapper(dir);
  m.start('box:-2000,-2000,2000,2000');
  const guarded = makeMapper(dir, { waypointFilter: null }).m;
  guarded.start('box:-2000,-2000,2000,2000');
  assert.ok(m.status().waypoints < guarded.status().waypoints);
  m.stop(); guarded.stop();
  rmDir(dir);
});

test('needed and boxes modes use the host-provided boxes', () => {
  const dir = tmpDir();
  let boxes = [[30000, 30000, 30500, 30500], [-40000, 5000, -39500, 5500]];
  const { m } = makeMapper(dir, { getTargetBoxes: () => boxes });
  assert.match(m.start('needed'), /started/);
  const two = m.status().waypoints;
  assert.ok(two > 30, `waypoints ${two}`);
  m.stop();
  boxes = [boxes[0]];
  m.start('boxes');
  assert.ok(m.status().waypoints < two);
  m.stop();
  boxes = [];
  m.start('needed');
  assert.equal(m.status().waypoints, 0, 'no boxes, nothing to fly');
  m.stop();
  rmDir(dir);
});

test('unknown modes are refused with the list of valid ones', () => {
  const dir = tmpDir();
  const { m } = makeMapper(dir);
  assert.match(m.start('sideways'), /unknown mode.*boxes, needed/);
  rmDir(dir);
});

test('coverage is seeded from saved render centres so a restart skips flown ground', () => {
  const dir = tmpDir();
  const cells = [];
  for (let x = 20000; x <= 20500; x += 56) for (let z = 20000; z <= 20500; z += 56) cells.push({ x, z });
  const { m } = makeMapper(dir, { loadCoveredCells: () => cells });
  m.start('box:20000,20000,21000,21000');
  const st = m.status();
  assert.ok(st.covered > 0 && st.covered < st.waypoints, `${st.covered}/${st.waypoints}`);
  m.stop();
  rmDir(dir);
});

test('output: coverage.json round trips; tiles only when asked', () => {
  const dir = tmpDir();
  let out = createOutput(dir, { tiles: false });
  out.saveTile({ centerX: 1000, centerZ: 2000, pngBuffer: Buffer.from('x'), radius: 56, pixelSize: 8 });
  out.saveCoverage();
  assert.equal(fs.existsSync(path.join(dir, 'tiles')), false);
  out = createOutput(dir, { tiles: true });
  assert.ok(out.loadCoveredCells().some((c) => Math.abs(c.x - 1000) <= 28 && Math.abs(c.z - 2000) <= 28));
  out.saveTile({ centerX: 1000, centerZ: 2000, pngBuffer: Buffer.from('x'), radius: 56, pixelSize: 8 });
  assert.equal(out.count(), 1);
  rmDir(dir);
});

test('kickText flattens chat components; classifyKick separates captcha from rate limits', () => {
  assert.equal(kickText('{"text":"Hello ","extra":[{"text":"world"}]}'), 'Hello world');
  assert.equal(kickText({ translate: 'multiplayer.disconnect.kicked' }), 'multiplayer.disconnect.kicked');
  assert.equal(kickText('plain text'), 'plain text');
  assert.equal(kickText({ type: 'compound', value: { text: { type: 'string', value: 'x' } } }).length > 0, true);
  assert.equal(classifyKick('Anti Bot protection: please verify'), 'captcha');
  assert.equal(classifyKick('You must prove you\'re a human first'), 'captcha');
  assert.equal(classifyKick('You are logging in too fast'), 'rate-limit');
  assert.equal(classifyKick('Flying is not enabled on this server'), 'other');
});

test('logger: levels, json format and secret scrubbing', () => {
  const seen = [];
  const log = createLogger({ level: 'info', format: 'json', secrets: ['SECRET_TOKEN_VALUE'], console: false, sink: (e) => seen.push(e) });
  log.debug('hidden');
  log.info('token is SECRET_TOKEN_VALUE ok', { extra: 'SECRET_TOKEN_VALUE' });
  log.line('Kicked: anti bot');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].msg, 'token is *** ok');
  assert.equal(seen[0].extra, '***');
  assert.equal(seen[1].level, 'warn');
  assert.equal(log.scrub('x SECRET_TOKEN_VALUE'), 'x ***');
});

test('status file round trip and formatting', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'status.json');
  assert.match(formatStatus(null), /No status file/);
  writeStatusFile(f, { updatedAt: new Date().toISOString(), connection: 'main', mapping: { state: 'mapping', mode: 'ring', active: true, covered: 3, waypoints: 9, pos: { x: 1, y: 2, z: 3 } }, recorder: { chunksIngested: 5, regionsWritten: 1, regions: 1 }, output: { regionFiles: 1, regionsDir: 'x' }, memory: { rssMb: 100 } });
  const txt = formatStatus(readStatusFile(f));
  assert.match(txt, /connection : main/);
  assert.match(txt, /covered=3\/9/);
  assert.doesNotMatch(txt, /STALE/);
  assert.match(formatStatus({ updatedAt: new Date(Date.now() - 600000).toISOString() }), /STALE/);
  rmDir(dir);
});
