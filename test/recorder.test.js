'use strict';
// Chunk recorder with a fake bot: guards, state checks, flush on close, dedup.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.11');
const Chunk = require('prismarine-chunk')(registry);
const { tmpDir, rmDir } = require('./helpers');
const { createWriter } = require('../lib/xaero-writer');
const { createRecorder } = require('../lib/recorder');
const { regionName } = require('../lib/regions');

function solidChunk() {
  const c = new Chunk({ minY: -64, worldHeight: 384 });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) c.setBlockStateId(new Vec3(x, 70, z), registry.blocksByName.stone.defaultState);
  return c;
}
function fakeBot(dimension = 'overworld') {
  const bot = new EventEmitter();
  const col = solidChunk();
  bot.registry = registry;
  bot.game = { dimension };
  bot.world = { getColumn: () => col };
  return bot;
}
const tick = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const load = (bot, cx, cz) => bot.emit('chunkColumnLoad', { x: cx * 16, z: cz * 16 });

test('allowed chunks become region files; spawn-lobby and out-of-limit chunks are skipped', async () => {
  const dir = tmpDir();
  const writer = createWriter({ outDir: dir });
  const regions = [];
  const rec = createRecorder({ writer, guard: { skipSpawnRegions: true, maxAbsBlock: 150000 }, dimension: 'overworld', onRegion: (r) => regions.push(r) });
  const bot = fakeBot();
  rec.attach(bot);
  load(bot, 100, 100);   // region 3,3: fine
  load(bot, 0, 0);       // region 0,0: lobby, guarded
  load(bot, -17, 5);     // region -1,0: lobby, guarded
  load(bot, 10000, 0);   // region 312: beyond 150000
  await tick();
  const s = rec.stats();
  assert.equal(s.chunksIngested, 1);
  assert.equal(s.skippedGuard, 3);
  await rec.close();
  assert.deepEqual(fs.readdirSync(dir), [regionName(3, 3)]);
  assert.deepEqual(regions.map((r) => [r.rx, r.rz]), [[3, 3]]);
  rmDir(dir);
});

test('nothing is recorded while canRecord() is false or the bot is in another dimension', async () => {
  const dir = tmpDir();
  const writer = createWriter({ outDir: dir });
  let on = false;
  const rec = createRecorder({ writer, guard: {}, dimension: 'overworld', canRecord: () => on });
  const bot = fakeBot();
  rec.attach(bot);
  load(bot, 100, 100); await tick();
  assert.equal(rec.stats().chunksIngested, 0);
  on = true;
  const nether = fakeBot('minecraft:the_nether');
  rec.attach(nether);
  load(nether, 100, 100); await tick();
  assert.equal(rec.stats().chunksIngested, 0);
  load(bot, 101, 100); await tick();
  assert.equal(rec.stats().chunksIngested, 1);
  await rec.close();
  rmDir(dir);
});

test('a chunk re-sent within two minutes is not ingested twice', async () => {
  const dir = tmpDir();
  const rec = createRecorder({ writer: createWriter({ outDir: dir }), guard: {}, dimension: 'overworld' });
  const bot = fakeBot();
  rec.attach(bot);
  load(bot, 100, 100); await tick();
  load(bot, 100, 100); await tick();
  assert.equal(rec.stats().chunksIngested, 1);
  await rec.close();
  rmDir(dir);
});

test('a failing column accessor is counted, logged and does not stop the recorder', async () => {
  const dir = tmpDir();
  const logs = [];
  const rec = createRecorder({ writer: createWriter({ outDir: dir }), guard: {}, dimension: 'overworld', log: (m) => logs.push(m) });
  const bad = fakeBot();
  bad.world = { getColumn: () => ({ /* not a column */ }) };
  rec.attach(bad);
  load(bad, 100, 100); await tick();
  assert.equal(rec.stats().errors, 1);
  assert.equal(logs.length, 1);
  const good = fakeBot();
  rec.attach(good);
  load(good, 101, 100); await tick();
  assert.equal(rec.stats().chunksIngested, 1);
  await rec.close();
  rmDir(dir);
});
