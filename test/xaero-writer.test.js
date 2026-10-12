'use strict';
// createWriter: ingest -> flush, merge with a file on disk, newest wins, atomic writes, eviction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, rmDir } = require('./helpers');
const { createWriter, encodeRegion, decodeRegion, zipRegion, unzipRegion } = require('../lib/xaero-writer');

const read = (f) => decodeRegion(unzipRegion(fs.readFileSync(f)));
const flat = (state, height, extra = {}) => () => ({ state, height, biome: 'plains', light: 0, ...extra });

test('ingest + flush writes <rx>_<rz>.zip with correct placement, negative regions too', async () => {
  const dir = tmpDir();
  const w = createWriter({ outDir: dir, dimension: 'overworld' });
  // chunk -1,-1 is region -1,-1 local chunk 31,31; chunk 33,2 is region 1,0 local chunk 1,2
  w.ingestChunk(-1, -1, (x, z) => ({ state: 'stone', height: 60 + x, biome: 'plains', light: z }));
  w.ingestChunk(33, 2, flat('sand', -10, { waterOverlay: true, topHeight: 62, biome: 'ocean' }));
  assert.deepEqual(w.regionsTouched().map((r) => `${r.regionX},${r.regionZ}`).sort(), ['-1,-1', '1,0']);
  const f1 = await w.flush(-1, -1), f2 = await w.flush(1, 0);
  assert.equal(path.basename(f1), '-1_-1.zip');
  const a = read(f1);
  assert.equal(a.size, 256);
  const c = a.get(`${496 + 5},${496 + 7}`);
  assert.deepEqual([c.height, c.light, c.state, c.biome], [65, 7, 'stone', 'plains']);
  const b = read(f2).get('16,32');
  assert.deepEqual([b.height, b.state, b.biome, b.topHeight, b.waterOverlay], [-10, 'sand', 'ocean', 62, true]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['-1_-1.zip', '1_0.zip']); // no temp files left behind
  rmDir(dir);
});

test('merge with an existing file: untouched chunks kept, re-seen chunk replaced (newest wins)', async () => {
  const dir = tmpDir();
  const old = new Map();
  for (let x = 0; x < 32; x++) for (let z = 0; z < 16; z++) old.set(`${x},${z}`, { state: 'dirt', height: 70, biome: 'forest' });
  const file = path.join(dir, '0_0.zip');
  fs.writeFileSync(file, zipRegion(encodeRegion(old)));
  const past = new Date(Date.now() - 60000); fs.utimesSync(file, past, past);

  const w = createWriter({ outDir: dir });
  w.ingestChunk(1, 0, flat('grass_block', 71));
  w.ingestChunk(0, 1, (x, z) => (x === 0 && z === 0 ? null : { state: 'oak_leaves', height: 90, biome: 'forest', props: { distance: '1', persistent: 'false', waterlogged: 'false' } }));
  await w.flush(0, 0);
  const p = read(file);
  assert.equal(p.get('3,3').state, 'dirt');
  assert.equal(p.get('20,3').state, 'grass_block');
  assert.equal(p.get('20,3').height, 71);
  assert.equal(p.get('5,20').state, 'oak_leaves');
  assert.equal(p.get('0,16').state, 'air'); // accessor gave null, nothing on disk: filler
  assert.equal(p.get('0,16').height, -64);
  rmDir(dir);
});

test('a file rewritten by someone else after the ingest beats memory; our own previous flush does not', async () => {
  const dir = tmpDir();
  const w = createWriter({ outDir: dir });
  w.ingestChunk(0, 0, flat('stone', 64));
  const file = await w.flush(0, 0);
  w.ingestChunk(0, 0, flat('andesite', 65));
  await w.flush(0, 0);
  assert.equal(read(file).get('1,1').state, 'andesite');
  const theirs = new Map([['1,1', { state: 'diamond_block', height: 100, biome: 'plains' }]]);
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(file, zipRegion(encodeRegion(theirs)));
  const theirTime = new Date(Date.now() - 5); fs.utimesSync(file, theirTime, theirTime);
  await new Promise((r) => setTimeout(r, 20));
  w.ingestChunk(5, 5, flat('gravel', 50));
  await w.flush(0, 0);
  const p = read(file);
  assert.equal(p.get('1,1').state, 'diamond_block');
  assert.equal(p.get('85,85').state, 'gravel');
  rmDir(dir);
});

test('concurrent flushes of one region serialise and leave one valid file', async () => {
  const dir = tmpDir();
  const w = createWriter({ outDir: dir });
  for (let c = 0; c < 32; c++) w.ingestChunk(c, c, flat('stone', c));
  const files = await Promise.all([w.flush(0, 0), w.flush(0, 0), w.flush(0, 0)]);
  assert.equal(new Set(files).size, 1);
  assert.equal(read(files[0]).size, 32 * 256);
  assert.deepEqual(fs.readdirSync(dir), ['0_0.zip']);
  rmDir(dir);
});

test('evictOlderThan flushes dirty idle regions and drops them from memory', async () => {
  const dir = tmpDir();
  const w = createWriter({ outDir: dir, dimension: 'end' });
  assert.equal(w.ingestChunk(0, 0, () => null), false); // nothing seen: no region entry
  assert.equal(w.regionsTouched().length, 0);
  w.ingestChunk(0, 0, flat('end_stone', 50));
  w.ingestChunk(100, 0, flat('end_stone', 50));
  assert.equal((await w.evictOlderThan(60000)).length, 0); // both fresh
  assert.equal((await w.evictOlderThan(-1)).length, 2);
  assert.equal(w.stats().regions, 0);
  assert.ok(fs.existsSync(path.join(dir, '3_0.zip')));
  rmDir(dir);
});

test('an unreadable existing file is set aside, not overwritten blindly', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '0_0.zip'), 'not a zip');
  const w = createWriter({ outDir: dir });
  w.ingestChunk(0, 0, flat('stone', 64));
  await w.flush(0, 0);
  const names = fs.readdirSync(dir).sort();
  assert.equal(names[0], '0_0.zip');
  assert.match(names[1], /^0_0\.zip\.unreadable-\d+$/);
  rmDir(dir);
});
