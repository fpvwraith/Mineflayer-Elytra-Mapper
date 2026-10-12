'use strict';
// Xaero region codec: synthetic columns -> encodeRegion -> decodeRegion round trip, byte-level checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeRegion, decodeRegion, zipRegion, unzipRegion, encodeStateNbt } = require('../lib/xaero-writer/codec');

const strip = (s) => (s && s.startsWith('minecraft:') ? s.slice(10) : s);

function synthetic() {
  const cols = new Map();
  const states = ['stone', 'minecraft:sand', 'grass_block', 'oak_leaves', 'snow', 'water', 'air', 'netherite_block'];
  const biomes = ['plains', 'minecraft:ocean', 'snowy_taiga', null, 'biomeID:42'];
  let n = 0;
  // Several full chunks in different tiles; heights cover the whole 12-bit signed range.
  for (const [cx, cz] of [[0, 0], [5, 9], [31, 31], [16, 3], [7, 7]]) {
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const i = n++;
      const col = { state: states[i % states.length], height: [-64, -2048, 2047, 62, 0, -1, 255, 256, 319, -63][i % 10], light: i % 16, biome: biomes[i % biomes.length] };
      if (i % 7 === 0) col.props = { layers: String(1 + (i % 8)) };
      if (i % 5 === 0) { col.waterOverlay = true; col.topHeight = col.height + 1 + (i % 20); col.waterDepth = 1 + (i % 15); }
      if (i % 11 === 0) col.topHeight = col.height + 256; // stored byte equals the height's low byte: the flag must still be set
      cols.set(`${cx * 16 + x},${cz * 16 + z}`, col);
    }
  }
  return cols;
}

test('synthetic columns survive encode -> zip -> decode', () => {
  const cols = synthetic();
  const raw = encodeRegion(cols);
  assert.equal(raw[0], 0xff);
  assert.equal(raw.readInt16BE(1), 7);
  assert.equal(raw.readInt16BE(3), 8);
  const dec = decodeRegion(unzipRegion(zipRegion(raw)));
  assert.equal(dec.size, cols.size);
  for (const [k, col] of cols) {
    const d = dec.get(k);
    assert.ok(d, k);
    assert.equal(d.height, col.height, k);
    assert.equal(d.light, col.light ?? 0, k);
    assert.equal(d.state, strip(col.state), k);
    assert.equal(d.biome, col.biome == null ? null : strip(col.biome), k);
    assert.equal(d.topHeight, col.topHeight != null ? col.topHeight & 0xff : null, k);
    assert.equal(d.waterOverlay, !!col.waterOverlay, k);
    const plainGrass = strip(col.state) === 'grass_block' && !col.props;
    assert.deepEqual(d.props, plainGrass ? undefined : col.props, k);
    if (col.waterOverlay) assert.equal(d.waterDepth, col.waterDepth, k);
  }
});

test('decode -> encode gives back identical bytes (the codec is stable)', () => {
  const raw = encodeRegion(synthetic());
  assert.deepEqual(encodeRegion(decodeRegion(raw)), raw);
});

test('partially known chunk: unknown columns become air filler at minY, other chunks stay absent', () => {
  const cols = new Map([['3,4', { state: 'stone', height: 70, biome: 'plains' }]]);
  const dec = decodeRegion(encodeRegion(cols, { minY: -64 }));
  assert.equal(dec.size, 256);
  assert.equal(dec.get('3,4').state, 'stone');
  const filler = dec.get('0,0');
  assert.deepEqual([filler.state, filler.height, filler.biome], ['air', -64, null]);
  assert.equal(dec.has('16,0'), false);
});

test('an empty region encodes to the bare 5 byte header', () => {
  const buf = encodeRegion(new Map());
  assert.equal(buf.toString('hex'), 'ff00070008');
  assert.equal(decodeRegion(buf).size, 0);
});

test('block-state NBT matches the bytes Xaero writes for snow[layers=1]', () => {
  const real = '0a00000a000a50726f706572746965730800066c6179657273000131000800044e616d65000e6d696e6563726166743a736e6f7700';
  assert.equal(encodeStateNbt('snow', { layers: '1' }).toString('hex'), real);
  assert.equal(encodeStateNbt('minecraft:snow', { layers: '1' }).toString('hex'), real);
});

test('an out-of-range height is rejected, not silently wrapped', () => {
  assert.throws(() => encodeRegion(new Map([['0,0', { state: 'stone', height: 2048 }]])), RangeError);
});

test('a column key outside 0..511 is rejected', () => {
  assert.throws(() => encodeRegion(new Map([['512,0', { state: 'stone', height: 1 }]])), RangeError);
});

test('decodeRegion refuses garbage', () => {
  assert.throws(() => decodeRegion(Buffer.from('not a region')));
});
