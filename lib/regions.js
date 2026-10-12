'use strict';
// Region maths and guards shared by the recorder and the planner.
// A Xaero World Map region is 512x512 blocks (32x32 chunks); rx = floor(blockX / 512).

const REGION_SIZE = 512;
const MAX_REGION_INDEX = 58594; // |region| above this is outside the 30M-block world border
const DIMENSIONS = ['overworld', 'nether', 'end'];

const DIM_ALIASES = {
  overworld: 'overworld', 'minecraft:overworld': 'overworld',
  nether: 'nether', 'minecraft:the_nether': 'nether', the_nether: 'nether', 'minecraft:nether': 'nether',
  end: 'end', 'minecraft:the_end': 'end', the_end: 'end', 'minecraft:end': 'end',
};

// Canonical dimension name or null.
function normalizeDimension(d) {
  return DIM_ALIASES[String(d || '').toLowerCase()] || null;
}

const regionOfBlock = (v) => Math.floor(v / REGION_SIZE);
const regionOfChunk = (c) => c >> 5;
const regionName = (rx, rz) => `${rx}_${rz}.zip`;

// "-3_12.zip" -> { rx: -3, rz: 12 }; anything else (temp files, ".unreadable-..." copies) -> null.
function parseRegionName(name) {
  const m = /^(-?\d+)_(-?\d+)\.zip$/.exec(String(name));
  if (!m) return null;
  return { rx: Number(m[1]), rz: Number(m[2]) };
}

// The lobby / spawn area: |index| <= 1 covers blocks -512..1023 on each axis, a generous margin around the spawn lobby.
const isSpawnRegion = (rx, rz) => Math.abs(rx) <= 1 && Math.abs(rz) <= 1;

// True when any part of the region lies inside +-maxAbsBlock on both axes (and inside the world border).
function regionWithinLimit(rx, rz, maxAbsBlock) {
  if (Math.abs(rx) > MAX_REGION_INDEX || Math.abs(rz) > MAX_REGION_INDEX) return false;
  if (!Number.isFinite(maxAbsBlock)) return true;
  const ok = (r) => r * REGION_SIZE <= maxAbsBlock && r * REGION_SIZE + REGION_SIZE - 1 >= -maxAbsBlock;
  return ok(rx) && ok(rz);
}

// The single decision used everywhere: may we record this region?
// opts: { skipSpawnRegions = true, maxAbsBlock = 150000 }
function regionAllowed(rx, rz, opts = {}) {
  const skipSpawn = opts.skipSpawnRegions !== false;
  const max = opts.maxAbsBlock === undefined ? 150000 : opts.maxAbsBlock;
  if (skipSpawn && isSpawnRegion(rx, rz)) return false;
  return regionWithinLimit(rx, rz, max);
}

// Same decision for one block position (used to filter flight waypoints).
function blockAllowed(x, z, opts = {}) {
  return regionAllowed(regionOfBlock(x), regionOfBlock(z), opts);
}

module.exports = {
  REGION_SIZE, MAX_REGION_INDEX, DIMENSIONS, normalizeDimension,
  regionOfBlock, regionOfChunk, regionName, parseRegionName,
  isSpawnRegion, regionWithinLimit, regionAllowed, blockAllowed,
};
