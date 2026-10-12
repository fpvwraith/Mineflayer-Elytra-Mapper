'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/regions');
const P = require('../lib/planner');

test('regionOfBlock floors toward negative infinity', () => {
  assert.equal(R.regionOfBlock(0), 0);
  assert.equal(R.regionOfBlock(511), 0);
  assert.equal(R.regionOfBlock(512), 1);
  assert.equal(R.regionOfBlock(-1), -1);
  assert.equal(R.regionOfBlock(-512), -1);
  assert.equal(R.regionOfBlock(-513), -2);
  assert.equal(R.regionOfChunk(-1), -1);
  assert.equal(R.regionOfChunk(32), 1);
});

test('parseRegionName accepts region zips only', () => {
  assert.deepEqual(R.parseRegionName('-3_12.zip'), { rx: -3, rz: 12 });
  assert.equal(R.parseRegionName('0_0.zip.tmp-1-abc'), null);
  assert.equal(R.parseRegionName('0_0.zip.unreadable-123'), null);
  assert.equal(R.parseRegionName('status.json'), null);
});

test('normalizeDimension accepts canonical names and minecraft: aliases', () => {
  assert.equal(R.normalizeDimension('overworld'), 'overworld');
  assert.equal(R.normalizeDimension('minecraft:the_nether'), 'nether');
  assert.equal(R.normalizeDimension('minecraft:the_end'), 'end');
  assert.equal(R.normalizeDimension('moon'), null);
});

test('spawn guard: regions with |rx|<=1 and |rz|<=1 are never allowed by default', () => {
  for (let rx = -1; rx <= 1; rx++) for (let rz = -1; rz <= 1; rz++) assert.equal(R.regionAllowed(rx, rz), false, `${rx},${rz}`);
  assert.equal(R.regionAllowed(2, 0), true);
  assert.equal(R.regionAllowed(0, -2), true);
  assert.equal(R.regionAllowed(1, 2), true);
  assert.equal(R.regionAllowed(0, 0, { skipSpawnRegions: false }), true);
});

test('limit guard: maxAbsBlock defaults to 150000 and the world border is a hard cap', () => {
  assert.equal(R.regionAllowed(292, 0), true);      // blocks 149504..150015 still touch the limit
  assert.equal(R.regionAllowed(293, 0), false);     // starts at 150016
  assert.equal(R.regionAllowed(-293, 5), true);     // blocks -150016..-149505 touch it
  assert.equal(R.regionAllowed(-294, 5), false);
  assert.equal(R.regionAllowed(293, 0, { maxAbsBlock: 200000 }), true);
  assert.equal(R.regionAllowed(58595, 0, { maxAbsBlock: Infinity }), false);
  assert.equal(R.regionAllowed(58594, 0, { maxAbsBlock: Infinity }), true);
});

test('blockAllowed applies the same rules to a block position', () => {
  assert.equal(R.blockAllowed(0, 0), false);
  assert.equal(R.blockAllowed(1023, -512), false);
  assert.equal(R.blockAllowed(-513, 0), true);
  assert.equal(R.blockAllowed(1024, 0), true);
  assert.equal(R.blockAllowed(200000, 0), false);
});

test('boxRegions lists every region a box touches', () => {
  const r = P.boxRegions([-10, -10, 600, 10]);
  assert.deepEqual(r.map((x) => `${x.rx},${x.rz}`).sort(), ['-1,-1', '-1,0', '0,-1', '0,0', '1,-1', '1,0'].sort());
});

test('planBox: grid, centre-out order, accepts corners in any order and object form', () => {
  const pts = P.planBox({ x1: 30000, z1: 30000, x2: 29000, z2: 29000 }, { gridStep: 112 });
  assert.ok(pts.length > 90 && pts.length < 140, `got ${pts.length}`);
  const d = (p) => Math.hypot(p.x - 29500, p.z - 29500);
  for (let i = 1; i < pts.length; i++) assert.ok(d(pts[i]) >= d(pts[i - 1]) - 1e-9, 'sorted centre outwards');
  assert.ok(pts.every((p) => p.x % 112 === 0 && p.z % 112 === 0));
  assert.deepEqual(P.planBox([29000, 29000, 30000, 30000]), pts);
});

test('planBox drops waypoints in guarded regions and beyond the limit', () => {
  const near = P.planBox([-3000, -3000, 3000, 3000]);
  assert.ok(near.length > 0);
  assert.ok(near.every((p) => !R.isSpawnRegion(R.regionOfBlock(p.x), R.regionOfBlock(p.z))));
  assert.ok(near.every((p) => p.x < -512 || p.x > 1023 || p.z < -512 || p.z > 1023));
  const far = P.planBox([149000, 0, 152000, 3000]);
  assert.ok(far.every((p) => p.x <= 150000 + 511));
  assert.equal(P.planBox([0, 0, 400, 400]).length, 0, 'a box entirely inside the lobby area plans nothing');
});

test('planBox refuses absurdly large boxes', () => {
  assert.throws(() => P.planBox([-1000000, -1000000, 1000000, 1000000]), RangeError);
});

test('normBox rejects garbage', () => {
  assert.throws(() => P.normBox([1, 2, 3]), TypeError);
  assert.throws(() => P.normBox({ x1: 1, z1: 'a', x2: 3, z2: 4 }), TypeError);
});

// ---- needed-regions ----------------------------------------------------------------------------------
const NEEDED = {
  dimension: 'overworld', regionSizeBlocks: 512, cellSizeRegions: 2, count: 4,
  bounty: { regionX0: 100, regionZ0: 40, regionX1: 101, regionZ1: 41, blockX0: 51200, blockZ0: 20480, blockX1: 52224, blockZ1: 21504 },
  needed: [
    { cellX: 50, cellZ: 20, ring: 50, regionX0: 100, regionZ0: 40, regionX1: 101, regionZ1: 41, blockX0: 51200, blockZ0: 20480, blockX1: 52224, blockZ1: 21504, isBounty: false },
    { cellX: 51, cellZ: 20, ring: 51, regionX0: 102, regionZ0: 40, regionX1: 103, regionZ1: 41, blockX0: 52224, blockZ0: 20480, blockX1: 53248, blockZ1: 21504, isBounty: true },
    { cellX: 0, cellZ: 0, ring: 0, regionX0: 0, regionZ0: 0, regionX1: 1, regionZ1: 1, blockX0: 0, blockZ0: 0, blockX1: 1024, blockZ1: 1024, isBounty: false },
    { cellX: 400, cellZ: 0, ring: 400, regionX0: 800, regionZ0: 0, regionX1: 801, regionZ1: 1, isBounty: false }, // no block fields, far out
    { nonsense: true },
  ],
};

test('parseNeeded normalises the response and drops malformed cells', () => {
  const p = P.parseNeeded(NEEDED);
  assert.equal(p.cells.length, 4);
  assert.equal(p.bounty.blockX1, 52224);
  const far = p.cells[3];
  assert.equal(far.blockX0, 800 * 512);
  assert.equal(far.blockX1, 802 * 512); // derived: (regionX1 + 1) * 512
});

test('parseNeeded rejects an unexpected shape', () => {
  assert.throws(() => P.parseNeeded({}), /needed/);
  assert.throws(() => P.parseNeeded(null));
  assert.throws(() => P.parseNeeded({ needed: 'x' }));
});

test('neededToBoxes: bounty first, then by ring; spawn and out-of-limit cells dropped; end is made inclusive', () => {
  const boxes = P.neededToBoxes(P.parseNeeded(NEEDED));
  assert.deepEqual(boxes[0], [52224, 20480, 53247, 21503]); // the bounty cell
  assert.deepEqual(boxes[1], [51200, 20480, 52223, 21503]);
  assert.equal(boxes.length, 2, 'lobby cell (rings 0) and the cell beyond 150000 are dropped');
  assert.equal(P.neededToBoxes(P.parseNeeded(NEEDED), { maxCells: 1 }).length, 1);
  assert.equal(P.neededToBoxes(P.parseNeeded(NEEDED), { maxAbsBlock: 500000, skipSpawnRegions: false }).length, 4);
});

test('neededRegions fetches with a limit and validates the answer (stubbed fetch)', async () => {
  let seen = null;
  const fetchImpl = async (url) => { seen = url; return { ok: true, status: 200, json: async () => NEEDED }; };
  const p = await P.neededRegions({ url: 'https://example.invalid/', limit: 7, fetchImpl });
  assert.equal(seen, 'https://example.invalid/api/needed-regions?limit=7');
  assert.equal(p.cells.length, 4);
  await assert.rejects(P.neededRegions({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});
