'use strict';
// Output folder layout:
//   <dir>/regions/<dimension>/<rx>_<rz>.zip   Xaero World Map region files (written by lib/xaero-writer)
//   <dir>/tiles/tile_<cellX>_<cellZ>.png      optional PNG tiles (output.tiles = true)
//   <dir>/manifest.json                       index of the PNG tiles
//   <dir>/coverage.json                       where the bot has already flown (lets a restart skip covered ground)
//   <dir>/mapper-state.json                   persisted on/off + mode, for resume
//   <dir>/status.json                         live snapshot
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./json-store');

const GRID = 112;          // PNG tiles: one saved tile per ~112-block cell, newest wins
const COVER_GRID = 56;     // coverage points are kept on a 56-block lattice (one render radius)

function createOutput(outputDir, { tiles = false, dimension = 'overworld' } = {}) {
  const regionsDir = path.join(outputDir, 'regions', dimension);
  const tilesDir = path.join(outputDir, 'tiles');
  const manifestFile = path.join(outputDir, 'manifest.json');
  const coverageFile = path.join(outputDir, 'coverage.json');
  fs.mkdirSync(regionsDir, { recursive: true });
  if (tiles) fs.mkdirSync(tilesDir, { recursive: true });

  // PNG manifest: { "<cellX>_<cellZ>": { file, x, z, radius, pixelSize, timestamp } }
  let manifest = readJsonSafe(manifestFile, {});
  if (!manifest || Array.isArray(manifest)) manifest = {};

  // Coverage: Set of "gx,gz" on the COVER_GRID lattice.
  const cover = new Set();
  const saved = readJsonSafe(coverageFile, null);
  if (saved && Array.isArray(saved.cells)) for (const c of saved.cells) if (Array.isArray(c) && c.length === 2) cover.add(`${c[0]},${c[1]}`);
  let coverDirty = false;

  function noteCover(x, z) {
    const k = `${Math.round(x / COVER_GRID)},${Math.round(z / COVER_GRID)}`;
    if (!cover.has(k)) { cover.add(k); coverDirty = true; }
  }

  function saveCoverage() {
    if (!coverDirty) return;
    writeJsonAtomic(coverageFile, { version: 1, grid: COVER_GRID, cells: [...cover].map((k) => k.split(',').map(Number)) });
    coverDirty = false;
  }

  // Persist one render. r is what render.generateMappingRender returns (pngBuffer may be null: coverage only).
  function saveTile(r) {
    noteCover(r.centerX, r.centerZ);
    if (!tiles || !r.pngBuffer) return;
    const key = `${Math.round(r.centerX / GRID)}_${Math.round(r.centerZ / GRID)}`;
    const fileName = `tile_${key}.png`;
    try {
      fs.writeFileSync(path.join(tilesDir, fileName), r.pngBuffer);
    } catch (e) {
      console.error(`[output] failed to write ${fileName}: ${e.message}`);
      return;
    }
    manifest[key] = { file: `tiles/${fileName}`, x: r.centerX, z: r.centerZ, radius: r.radius, pixelSize: r.pixelSize, timestamp: new Date().toISOString() };
    writeJsonAtomic(manifestFile, manifest);
  }

  // Every saved render centre: the mapper seeds its "covered" set from these on startup so a restart doesn't
  // re-fly ground already mapped.
  function loadCoveredCells() {
    const out = [];
    for (const t of Object.values(manifest)) if (Number.isFinite(t.x) && Number.isFinite(t.z)) out.push({ x: t.x, z: t.z });
    for (const k of cover) { const [gx, gz] = k.split(',').map(Number); out.push({ x: gx * COVER_GRID, z: gz * COVER_GRID }); }
    return out;
  }

  function regionFileCount() {
    try { return fs.readdirSync(regionsDir).filter((n) => /^-?\d+_-?\d+\.zip$/.test(n)).length; } catch (e) { return 0; }
  }

  return {
    saveTile, loadCoveredCells, saveCoverage, regionFileCount,
    count: () => Object.keys(manifest).length,
    regionsDir, tilesDir, manifestFile, coverageFile,
  };
}

module.exports = { createOutput };
