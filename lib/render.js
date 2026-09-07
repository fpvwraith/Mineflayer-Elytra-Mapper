// Terrain render pipeline for the ARGUS mapper — extracted from the ARGUS
// honeypot's generateLocalMap so a self-hosted mapper renders pixel-for-pixel
// identically to the main project (same palette, biome tints and hillshade), and
// its tiles composite cleanly into the same community map.
//
// Overworld top-down render only (that's what the flying mapper produces). Each
// column is a real downsampled block texture (see block-render.js), shaded by a
// north-neighbour hillshade, blitted into a PNG via pngjs. Unmapped columns
// (unloaded chunk / nothing found) are written fully TRANSPARENT so overlapping
// renders composite instead of stamping opaque gaps over real data.
const { PNG } = require('pngjs');
const Vec3 = require('vec3');
const { THUMB, uniformThumb, getBlockPixels, blockNeedsBiomeTint } = require('./block-render.js');

// blocks each side of the render centre. 56 => a 113x113-column footprint, the
// value the ARGUS mapper is tuned around (render stays under the flight cadence).
const RENDER_RADIUS = 56;
const PIXEL_SIZE = THUMB; // each block's texture thumbnail blits 1:1 — no scaling

// Top-down raycast per column over the full build range (320 -> 0) so every
// column finds its OWN surface (build, land, or water) independent of the centre
// — a centre-anchored window locks onto an elevated build and renders the
// surrounding ocean as empty ("where's the water" bug). getBlockStateId + a
// registry lookup, NOT bot.blockAt(): blockAt's full Block construction is the
// dominant cost and this runs tens of thousands of times per render.
function sampleTopDownColumns(bot, centerX, centerZ, radius) {
  const span = radius * 2 + 1;
  const heights = new Array(span * span);
  const pixelBlocks = new Array(span * span);
  const pos = new Vec3(0, 0, 0);
  for (let iz = 0; iz < span; iz++) {
    pos.z = centerZ + (iz - radius);
    for (let ix = 0; ix < span; ix++) {
      pos.x = centerX + (ix - radius);
      let foundY = null;
      let pixels = uniformThumb([8, 8, 12]);
      for (let y = 320; y >= 0; y--) {
        pos.y = y;
        const stateId = bot.world.getBlockStateId(pos);
        const blockType = bot.registry.blocksByStateId[stateId];
        if (blockType && blockType.name !== 'air' && blockType.name !== 'cave_air' && blockType.name !== 'void_air') {
          foundY = y;
          let biomeName = null;
          if (blockNeedsBiomeTint(blockType.name)) {
            const biomeId = bot.world.getBiome(pos);
            biomeName = bot.registry.biomes[biomeId] ? bot.registry.biomes[biomeId].name : null;
          }
          pixels = getBlockPixels(blockType.name, biomeName);
          break;
        }
      }
      heights[iz * span + ix] = foundY;
      pixelBlocks[iz * span + ix] = pixels;
    }
  }
  return { pixelBlocks, heights };
}

// Hillshade compared to each column's NORTH neighbour (smaller z) — vanilla
// Minecraft's own map-item convention, and Xaero's. SIGN only (fixed +/-),
// not proportional to the height delta, so tree-canopy edges don't turn into
// bright/dark static (this is Xaero's "simple" terrainSlopes mode).
const UPHILL_SHADE = 1.15;
const DOWNHILL_SHADE = 0.85;
function computeReliefShades(heights, span) {
  const shades = new Array(heights.length);
  for (let iz = 0; iz < span; iz++) {
    for (let ix = 0; ix < span; ix++) {
      const idx = iz * span + ix;
      const h = heights[idx];
      const prevH = iz > 0 ? heights[idx - span] : h;
      let shade = 1.0;
      if (h !== null && prevH !== null) {
        if (h > prevH) shade = UPHILL_SHADE;
        else if (h < prevH) shade = DOWNHILL_SHADE;
      }
      shades[idx] = shade;
    }
  }
  return shades;
}

// Blit each column's shaded texture into a PNG. Unmapped columns (height null)
// are transparent so overlapping renders composite rather than stamping gaps.
function blitTransparent(pixelBlocks, shades, heights, span, px) {
  const png = new PNG({ width: span * px, height: span * px });
  for (let iz = 0; iz < span; iz++) {
    for (let ix = 0; ix < span; ix++) {
      const idx = iz * span + ix;
      const found = heights[idx] !== null;
      const pixels = pixelBlocks[idx];
      const shade = shades[idx];
      const gx = ix * px, gy = iz * px;
      for (let oy = 0; oy < px; oy++) {
        for (let ox = 0; ox < px; ox++) {
          const [r, g, b] = pixels[oy * px + ox];
          const pidx = (png.width * (gy + oy) + (gx + ox)) << 2;
          png.data[pidx] = Math.min(255, Math.round(r * shade));
          png.data[pidx + 1] = Math.min(255, Math.round(g * shade));
          png.data[pidx + 2] = Math.min(255, Math.round(b * shade));
          png.data[pidx + 3] = found ? 255 : 0;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

// Render a square footprint centred on (centerX, centerZ). Returns the PNG plus
// the metadata needed to place it in world-block space and decide whether it's
// worth saving (found/total = how many columns had real data vs unloaded).
function generateMappingRender(bot, centerX, centerZ, radius = RENDER_RADIUS) {
  const span = radius * 2 + 1;
  const { pixelBlocks, heights } = sampleTopDownColumns(bot, centerX, centerZ, radius);
  const shades = computeReliefShades(heights, span);
  let found = 0;
  for (const h of heights) if (h !== null) found++;
  const pngBuffer = blitTransparent(pixelBlocks, shades, heights, span, PIXEL_SIZE);
  return { pngBuffer, centerX, centerZ, radius, span, pixelSize: PIXEL_SIZE, found, total: span * span };
}

module.exports = { generateMappingRender, RENDER_RADIUS, PIXEL_SIZE };
