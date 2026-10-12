// columnFromPrismarine: one map column from a prismarine-chunk column (1.21.x), chosen the way Xaero's top-down
// world map chooses it. Rules were inferred from ~1,700 real Xaero 7.8 region files (overworld + End); see docs/xaero-format.md
// ("Top-block rules").

const { Vec3 } = require('vec3');

// Never the top block in real files although common (grass, glass, torches) -> Xaero does not draw them; scan on.
const INVISIBLE = new Set([
    'air', 'cave_air', 'void_air', 'barrier', 'light', 'structure_void', 'moving_piston',
    'short_grass', 'grass', 'tall_grass', 'large_fern', 'tall_seagrass',
    'glass', 'glass_pane',
    'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'redstone_torch', 'redstone_wall_torch',
    'copper_torch', 'copper_wall_torch',
]);
// Stored by Xaero as a non-water overlay above the real top block. The map ingest ignores non-water overlays, so the
// writer skips them too: the base underneath is what a real file's parser output shows.
const TRANSLUCENT_OVERLAY = /^(ice|frosted_ice|slime_block|honey_block|tinted_glass|tripwire|redstone_wire|.*stained_glass(_pane)?|(waxed_)?(exposed_|weathered_|oxidized_)?copper_grate)$/;
// Contain water without a waterlogged property. Real files show seagrass/kelp as the base under a water overlay.
const ALWAYS_WATERY = new Set(['seagrass', 'kelp', 'kelp_plant', 'tall_seagrass', 'bubble_column']);

const K_SKIP = 0, K_WATER = 1, K_OVERLAY = 2, K_WET_BASE = 3, K_BASE = 4;

// Per-registry cache: stateId -> { kind, name, props }. Built lazily; a few thousand states at most get touched.
const caches = new WeakMap();
function classify(registry, stateId) {
    let cache = caches.get(registry);
    if (!cache) caches.set(registry, cache = { Block: require('prismarine-block')(registry), byId: new Map() });
    let c = cache.byId.get(stateId);
    if (c) return c;
    const block = cache.Block.fromStateId(stateId, 0);
    const name = block.name;
    let props = null;
    const raw = block.getProperties ? block.getProperties() : {};
    if (raw && Object.keys(raw).length) { props = {}; for (const k of Object.keys(raw)) props[k] = String(raw[k]); }
    let kind;
    if (name === 'water' || name === 'bubble_column') kind = K_WATER;
    else if (INVISIBLE.has(name)) kind = ALWAYS_WATERY.has(name) || (props && props.waterlogged === 'true') ? K_WATER : K_SKIP;
    else if (TRANSLUCENT_OVERLAY.test(name)) kind = props && props.waterlogged === 'true' ? K_WATER : K_OVERLAY;
    else if (ALWAYS_WATERY.has(name) || (props && props.waterlogged === 'true')) kind = K_WET_BASE;
    else kind = K_BASE;
    c = { kind, name, props };
    cache.byId.set(stateId, c);
    return c;
}

// column: prismarine-chunk column; x, z: chunk-local 0..15.
// opts: registry (default column.registry), biomeName(id) override, minY/maxY scan range (default the column's
// build range), ceilingY: for dimensions with a roof (the nether: 127) - start below the first air under the roof.
// Returns { state, props?, height, light, biome, waterOverlay, topHeight, waterDepth?, overlayLight? }.
function columnFromPrismarine(column, x, z, opts = {}) {
    const registry = opts.registry || column.registry;
    if (!registry) throw new Error('columnFromPrismarine needs opts.registry (bot.registry)');
    const minY = opts.minY ?? column.minY ?? 0;
    const maxY = opts.maxY ?? (minY + (column.worldHeight ?? 256) - 1);
    const pos = new Vec3(x & 15, 0, z & 15);

    let y = maxY;
    if (opts.ceilingY != null) {
        // Nether roof: skip down to the first air below the ceiling; if the column is solid all the way, fall back to
        // the ceiling block itself. Unverified against real nether files - see docs/xaero-format.md.
        y = opts.ceilingY;
        let found = false;
        for (let yy = opts.ceilingY; yy >= minY; yy--) {
            pos.y = yy;
            if (classify(registry, column.getBlockStateId(pos)).kind !== K_BASE) { y = yy; found = true; break; }
        }
        if (!found) y = opts.ceilingY;
    }

    let firstOverlayY = null, waterTopY = null, waterCount = 0;
    let base = null, baseY = minY;
    const sections = Array.isArray(column.sections) && column.minY === minY ? column.sections : null;
    for (; y >= minY; y--) {
        if (sections && ((y - minY) & 15) === 15) {
            // Whole 16-block section empty (server-sent non-air count 0, or never sent): skip it - 3x faster in the air.
            const s = sections[(y - minY) >> 4];
            if (!s || (typeof s.isEmpty === 'function' && s.isEmpty())) { y -= 15; continue; }
        }
        pos.y = y;
        const c = classify(registry, column.getBlockStateId(pos));
        if (c.kind === K_SKIP) continue;
        if (c.kind === K_WATER || c.kind === K_OVERLAY) {
            if (firstOverlayY === null) firstOverlayY = y;
            if (c.kind === K_WATER) { if (waterTopY === null) waterTopY = y; waterCount++; }
            continue;
        }
        if (c.kind === K_WET_BASE) { if (firstOverlayY === null) firstOverlayY = y; if (waterTopY === null) waterTopY = y; waterCount++; }
        base = c; baseY = y;
        break;
    }

    // Nothing found: Xaero stores an explored-but-empty column as air at the bottom of the world (End void, holes).
    const col = { state: base ? base.name : 'air', height: base ? baseY : minY, light: 0, biome: null, waterOverlay: waterCount > 0, topHeight: null };
    if (base && base.props) col.props = base.props;
    // Light = block light (not sky light) of the space above the base: real wilderness columns are almost all 0.
    if (typeof column.getBlockLight === 'function') {
        pos.y = col.height + 1;
        try { col.light = column.getBlockLight(pos) | 0; } catch (e) { col.light = 0; }
    }
    // topHeight = y of the highest overlay block (water surface, or the ice/glass above it) when it differs.
    if (firstOverlayY !== null && firstOverlayY !== col.height) col.topHeight = firstOverlayY;
    if (col.waterOverlay) {
        col.waterDepth = Math.min(15, waterCount);
        if (typeof column.getBlockLight === 'function') {
            pos.y = waterTopY + 1;
            try { col.overlayLight = column.getBlockLight(pos) | 0; } catch (e) { col.overlayLight = 0; }
        }
    }
    pos.y = col.height;
    const biomeId = column.getBiome(pos);
    if (opts.biomeName) col.biome = opts.biomeName(biomeId);
    else { const b = registry.biomes && registry.biomes[biomeId]; col.biome = b ? b.name : null; }
    return col;
}

module.exports = { columnFromPrismarine, INVISIBLE, TRANSLUCENT_OVERLAY, ALWAYS_WATERY };
