'use strict';
// Planning helpers: turn a rectangle (or the areas an ARGUS-compatible map still lacks) into flight waypoints
// and region lists. Pure functions apart from neededRegions(), which does one HTTP GET.
const { REGION_SIZE, regionOfBlock, regionAllowed, blockAllowed } = require('./regions');

const DEFAULT_GRID_STEP = 112; // ~ one render footprint; adjacent flight lanes overlap slightly

function normBox(box) {
  const arr = Array.isArray(box) ? box : [box && box.x1, box && box.z1, box && box.x2, box && box.z2];
  const n = arr.map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) throw new TypeError('a box is {x1,z1,x2,z2} or [x1,z1,x2,z2] (finite numbers)');
  return { minX: Math.min(n[0], n[2]), maxX: Math.max(n[0], n[2]), minZ: Math.min(n[1], n[3]), maxZ: Math.max(n[1], n[3]) };
}

// Regions touched by a box: [{rx, rz}].
function boxRegions(box) {
  const b = normBox(box);
  const out = [];
  for (let rx = regionOfBlock(b.minX); rx <= regionOfBlock(b.maxX); rx++)
    for (let rz = regionOfBlock(b.minZ); rz <= regionOfBlock(b.maxZ); rz++) out.push({ rx, rz });
  return out;
}

// Grid of waypoints covering a box, ordered from the centre outward (the order the flying mapper uses).
// opts: { gridStep, skipSpawnRegions, maxAbsBlock, maxPoints = 500000 }
function planBox(box, opts = {}) {
  const b = normBox(box);
  const step = opts.gridStep || DEFAULT_GRID_STEP;
  const maxPoints = opts.maxPoints || 500000;
  const gx0 = Math.floor(b.minX / step) * step, gx1 = Math.ceil(b.maxX / step) * step;
  const gz0 = Math.floor(b.minZ / step) * step, gz1 = Math.ceil(b.maxZ / step) * step;
  const total = (Math.floor((gx1 - gx0) / step) + 1) * (Math.floor((gz1 - gz0) / step) + 1);
  if (total > maxPoints) throw new RangeError(`box is too large: ${total} waypoints (max ${maxPoints}); use smaller boxes`);
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const pts = [];
  for (let x = gx0; x <= gx1; x += step)
    for (let z = gz0; z <= gz1; z += step) {
      if (!blockAllowed(x, z, opts)) continue;
      pts.push({ x, z, d2: (x - cx) ** 2 + (z - cz) ** 2 });
    }
  pts.sort((a, c) => a.d2 - c.d2);
  return pts.map(({ x, z }) => ({ x, z }));
}

// ---- needed regions (GET <base>/api/needed-regions) ----------------------------------------------------------

// Validate and normalise a needed-regions response. Throws on a wrong shape.
// Returns { dimension, regionSizeBlocks, cellSizeRegions, count, bounty, cells: [...] }; every cell has
// regionX0..regionZ1 (inclusive region indices) and blockX0..blockZ1 (block ranges [X0, X1), X1 exclusive).
function parseNeeded(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.needed)) throw new Error('needed-regions: unexpected response (no "needed" array)');
  const size = Number.isFinite(json.regionSizeBlocks) ? json.regionSizeBlocks : REGION_SIZE;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const norm = (c) => {
    if (!c || typeof c !== 'object') return null;
    const r = { regionX0: num(c.regionX0), regionZ0: num(c.regionZ0), regionX1: num(c.regionX1), regionZ1: num(c.regionZ1) };
    if (Object.values(r).some((v) => v === null)) return null;
    r.blockX0 = num(c.blockX0) ?? r.regionX0 * size; r.blockZ0 = num(c.blockZ0) ?? r.regionZ0 * size;
    r.blockX1 = num(c.blockX1) ?? (r.regionX1 + 1) * size; r.blockZ1 = num(c.blockZ1) ?? (r.regionZ1 + 1) * size;
    r.cellX = num(c.cellX); r.cellZ = num(c.cellZ); r.ring = num(c.ring); r.isBounty = !!c.isBounty;
    return r;
  };
  const cells = json.needed.map(norm).filter(Boolean);
  return {
    dimension: json.dimension || 'overworld', regionSizeBlocks: size, cellSizeRegions: num(json.cellSizeRegions) || 2,
    count: Number.isFinite(json.count) ? json.count : cells.length, bounty: json.bounty ? norm(json.bounty) : null, cells,
  };
}

// Flight boxes ([x1,z1,x2,z2], inclusive block coordinates), bounty cell first, then by ring. Cells that the
// guards forbid entirely (spawn lobby, outside maxAbsBlock) are dropped.
// opts: { maxCells, skipSpawnRegions, maxAbsBlock }
function neededToBoxes(parsed, opts = {}) {
  let cells = parsed.cells.filter((c) => {
    for (let rx = c.regionX0; rx <= c.regionX1; rx++)
      for (let rz = c.regionZ0; rz <= c.regionZ1; rz++) if (regionAllowed(rx, rz, opts)) return true;
    return false;
  });
  cells = cells.slice().sort((a, b) => (Number(b.isBounty) - Number(a.isBounty)) || ((a.ring ?? 0) - (b.ring ?? 0)));
  if (opts.maxCells) cells = cells.slice(0, opts.maxCells);
  return cells.map((c) => [c.blockX0, c.blockZ0, c.blockX1 - 1, c.blockZ1 - 1]);
}

// Fetch the list. opts: { url = 'https://map.argus.tools', limit = 50, fetchImpl, timeoutMs = 20000 }
async function neededRegions(opts = {}) {
  const base = String(opts.url || 'https://map.argus.tools').replace(/\/+$/, '');
  const f = opts.fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('neededRegions needs Node 18+ (global fetch) or opts.fetchImpl');
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit || 50)));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs || 20000);
  try {
    const res = await f(`${base}/api/needed-regions?limit=${limit}`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`needed-regions: HTTP ${res.status}`);
    return parseNeeded(await res.json());
  } finally { clearTimeout(t); }
}

module.exports = { DEFAULT_GRID_STEP, normBox, boxRegions, planBox, parseNeeded, neededToBoxes, neededRegions };
