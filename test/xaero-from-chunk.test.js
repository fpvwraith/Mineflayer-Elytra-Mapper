'use strict';
// columnFromPrismarine on synthetic 1.21.11 prismarine-chunk columns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.11');
const Chunk = require('prismarine-chunk')(registry);
const Block = require('prismarine-block')(registry);
const { tmpDir, rmDir } = require('./helpers');
const { columnFromPrismarine, createWriter, decodeRegion, unzipRegion } = require('../lib/xaero-writer');

const B = registry.blocksByName;
const chunk = (minY = -64, height = 384) => new Chunk({ minY, worldHeight: height });
function put(c, x, z, y, name, props) {
  c.setBlockStateId(new Vec3(x, y, z), props ? Block.fromProperties(name, props, 0).stateId : B[name].defaultState);
}
function biome(c, x, z, name) {
  for (let y = c.minY; y < c.minY + c.worldHeight; y += 4) c.setBiome(new Vec3(x, y, z), registry.biomesByName[name].id);
}

test('plain ground: top non-air block, its height, biome name', () => {
  const c = chunk();
  for (let y = -64; y <= 63; y++) put(c, 1, 2, y, y === 63 ? 'grass_block' : 'stone');
  biome(c, 1, 2, 'plains');
  const col = columnFromPrismarine(c, 1, 2);
  assert.equal(col.state, 'grass_block'); assert.equal(col.height, 63); assert.equal(col.biome, 'plains');
  assert.equal(col.waterOverlay, false); assert.equal(col.topHeight, null);
});

test('short grass, tall grass, glass and torches are see-through; flowers, snow, leaves, fern are not', () => {
  const c = chunk();
  const cases = [['short_grass', 'grass_block'], ['glass', 'grass_block'], ['torch', 'grass_block'], ['tall_grass', 'grass_block'],
    ['poppy', 'poppy'], ['snow', 'snow'], ['oak_leaves', 'oak_leaves'], ['fern', 'fern']];
  cases.forEach(([top], i) => {
    put(c, i, 0, 60, 'dirt'); put(c, i, 0, 61, 'grass_block');
    if (top === 'tall_grass') { put(c, i, 0, 62, 'tall_grass', { half: 'lower' }); put(c, i, 0, 63, 'tall_grass', { half: 'upper' }); }
    else put(c, i, 0, 62, top);
  });
  cases.forEach(([top, want], i) => {
    const col = columnFromPrismarine(c, i, 0);
    assert.equal(col.state, want, top);
    assert.equal(col.height, want === 'grass_block' ? 61 : 62, top);
  });
  assert.deepEqual(columnFromPrismarine(c, 5, 0).props, { layers: '1' });
});

test('ocean: the seafloor is the base, water is an overlay with depth and surface height', () => {
  const c = chunk();
  for (let y = 40; y <= 50; y++) put(c, 3, 3, y, 'sand');
  for (let y = 51; y <= 62; y++) put(c, 3, 3, y, 'water');
  biome(c, 3, 3, 'ocean');
  const col = columnFromPrismarine(c, 3, 3);
  assert.equal(col.state, 'sand'); assert.equal(col.height, 50); assert.equal(col.waterOverlay, true);
  assert.equal(col.topHeight, 62); assert.equal(col.waterDepth, 12); assert.equal(col.biome, 'ocean');
});

test('seagrass and waterlogged blocks are the base under a water overlay', () => {
  const c = chunk();
  put(c, 4, 4, 50, 'sand'); put(c, 4, 4, 51, 'seagrass');
  for (let y = 52; y <= 62; y++) put(c, 4, 4, y, 'water');
  let col = columnFromPrismarine(c, 4, 4);
  assert.equal(col.state, 'seagrass'); assert.equal(col.height, 51); assert.equal(col.waterDepth, 12); assert.equal(col.topHeight, 62);
  put(c, 5, 5, 61, 'stone'); put(c, 5, 5, 62, 'oak_slab', { type: 'bottom', waterlogged: true });
  col = columnFromPrismarine(c, 5, 5);
  assert.equal(col.state, 'oak_slab'); assert.equal(col.height, 62); assert.equal(col.waterOverlay, true); assert.equal(col.topHeight, null);
});

test('ice over water reads as water; stained glass is skipped; packed ice is a normal top block', () => {
  const c = chunk();
  put(c, 7, 7, 55, 'gravel');
  for (let y = 56; y <= 61; y++) put(c, 7, 7, y, 'water');
  put(c, 7, 7, 62, 'ice');
  let col = columnFromPrismarine(c, 7, 7);
  assert.equal(col.state, 'gravel'); assert.equal(col.waterOverlay, true); assert.equal(col.topHeight, 62); assert.equal(col.waterDepth, 6);
  put(c, 8, 8, 70, 'stone'); put(c, 8, 8, 75, 'red_stained_glass');
  col = columnFromPrismarine(c, 8, 8);
  assert.equal(col.state, 'stone'); assert.equal(col.height, 70); assert.equal(col.waterOverlay, false); assert.equal(col.topHeight, 75);
  put(c, 9, 9, 62, 'packed_ice');
  assert.equal(columnFromPrismarine(c, 9, 9).state, 'packed_ice');
});

test('an empty column (End void) is air at the bottom of the world; block light above the top is recorded', () => {
  const c = chunk(0, 256);
  biome(c, 0, 0, 'the_end');
  const col = columnFromPrismarine(c, 0, 0);
  assert.deepEqual([col.state, col.height, col.biome, col.waterOverlay], ['air', 0, 'the_end', false]);
  put(c, 1, 1, 64, 'end_stone'); c.setBlockLight(new Vec3(1, 65, 1), 13);
  assert.equal(columnFromPrismarine(c, 1, 1).light, 13);
});

test('nether ceiling mode starts below the bedrock roof', () => {
  const c = chunk(0, 256);
  for (let y = 0; y <= 40; y++) put(c, 2, 2, y, 'netherrack');
  for (let y = 100; y <= 127; y++) put(c, 2, 2, y, y >= 123 ? 'bedrock' : 'netherrack');
  let col = columnFromPrismarine(c, 2, 2, { ceilingY: 127 });
  assert.equal(col.height, 40); assert.equal(col.state, 'netherrack');
  col = columnFromPrismarine(c, 2, 2);
  assert.equal(col.height, 127); assert.equal(col.state, 'bedrock');
});

test('end to end: prismarine chunk -> writer -> region file -> decode', async () => {
  const c = chunk();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    put(c, x, z, 60, 'sand');
    if (x < 8) { put(c, x, z, 61, 'water'); put(c, x, z, 62, 'water'); }
    biome(c, x, z, x < 8 ? 'ocean' : 'beach');
  }
  const dir = tmpDir();
  const w = createWriter({ outDir: dir });
  w.ingestChunk(-3, 4, (x, z) => columnFromPrismarine(c, x, z)); // chunk -3 -> region -1, local chunk 29
  const file = await w.flush(-1, 0);
  const p = decodeRegion(unzipRegion(fs.readFileSync(file)));
  const wet = p.get(`${29 * 16 + 2},${4 * 16 + 5}`), dry = p.get(`${29 * 16 + 12},${4 * 16 + 5}`);
  assert.deepEqual([wet.height, wet.state, wet.biome, wet.topHeight, wet.waterOverlay], [60, 'sand', 'ocean', 62, true]);
  assert.deepEqual([dry.height, dry.state, dry.biome, dry.topHeight, dry.waterOverlay], [60, 'sand', 'beach', null, false]);
  rmDir(dir);
});
