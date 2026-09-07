// Saves the mapper's renders as a folder of flat PNG tiles + a manifest.json,
// ready for upload.js to POST to an ARGUS instance. Deduped by a footprint-sized
// grid so the folder stays bounded (one tile per ~112-block cell, newest wins)
// instead of accumulating one file per 70-block render step.
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./json-store');

const GRID = 112; // ~= one render footprint (2*RENDER_RADIUS); one saved tile per cell

function createOutput(outputDir) {
  const tilesDir = path.join(outputDir, 'tiles');
  const manifestFile = path.join(outputDir, 'manifest.json');
  fs.mkdirSync(tilesDir, { recursive: true });

  // manifest: { "<cellX>_<cellZ>": { file, x, z, radius, pixelSize, timestamp } }
  let manifest = readJsonSafe(manifestFile, {});
  if (Array.isArray(manifest)) manifest = {}; // guard against an old/foreign shape

  function cellKey(x, z) {
    return `${Math.round(x / GRID)}_${Math.round(z / GRID)}`;
  }

  // Persist one render. renderResult is what render.generateMappingRender returns.
  function saveTile(r) {
    const key = cellKey(r.centerX, r.centerZ);
    const fileName = `tile_${key}.png`;
    try {
      fs.writeFileSync(path.join(tilesDir, fileName), r.pngBuffer);
    } catch (e) {
      console.error(`[output] failed to write ${fileName}: ${e.message}`);
      return;
    }
    manifest[key] = {
      file: `tiles/${fileName}`,
      x: r.centerX, z: r.centerZ,
      radius: r.radius, pixelSize: r.pixelSize,
      timestamp: new Date().toISOString(),
    };
    writeJsonAtomic(manifestFile, manifest);
  }

  // Every saved tile's centre — the mapper seeds its in-memory "covered" set from
  // these on startup so a restart doesn't re-fly ground already mapped to disk.
  function loadCoveredCells() {
    const m = readJsonSafe(manifestFile, {});
    if (!m || Array.isArray(m)) return [];
    return Object.values(m).map(t => ({ x: t.x, z: t.z })).filter(t => Number.isFinite(t.x) && Number.isFinite(t.z));
  }

  function count() {
    return Object.keys(manifest).length;
  }

  return { saveTile, loadCoveredCells, count, manifestFile, tilesDir };
}

module.exports = { createOutput };
