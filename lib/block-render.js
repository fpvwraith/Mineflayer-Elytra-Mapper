// Shared block-color/texture rendering logic - extracted from bot-core.js so
// the Xaero-region ingestion pipeline (parses community-contributed
// region.xaero files, see tools/parse-xaero-region.js) can render terrain
// using the EXACT same texture/biome/legacy-color logic the bots' own
// generateLocalMap already uses, rather than a second copy that drifts out
// of sync over time.

// Real per-block texture THUMBNAILS sourced from Mojang's own client.jar
// textures (tools/build-block-palette.js) - not one flat average color per
// block. A flat average was tried first and confirmed live to look muddy
// and blobby next to Xaero's World Map Download: averaging real texture
// pixels desaturates toward gray-brown, and a single solid color per block
// can never show the per-pixel noise (grass speckle, wood grain, leaf
// gaps) that's most of what makes a real map read as "textured" instead of
// a flat color mosaic. Each entry is a THUMB x THUMB (see THUMB below)
// array of real downsampled texture pixels, blitted per-sub-pixel by
// callers. Blocks with no entry here (mostly multi-part furniture - beds,
// banners, carpets - with no simple flat texture matching the block name)
// fall through to legacyColorForBlock.
const blockTextureColors = require('./data/block-texture-colors.json');
const THUMB = 8; // must match the thumbSize tools/build-block-palette.js was run with

// Real per-biome grass/foliage/water colors (tools/build-biome-tints.js),
// reimplementing vanilla's actual climate-colormap algorithm against
// Mojang's own biome definitions and colormap images - NOT sourced from
// minecraft-data's tints.json, which has a real data gap for this version
// (confirmed live: ~55 of 65 biomes, including plains/forest/jungle/
// desert/ocean, all resolve to color 0 there).
const biomeTints = require('./data/biome-tints.json');
const DEFAULT_TINT = { grass: [124, 189, 107], foliage: [107, 155, 68], water: [63, 118, 228] };

const BLOCK_COLORS = {
    grass_block: [86, 156, 61], dirt: [134, 96, 67], podzol: [95, 74, 47],
    coarse_dirt: [117, 87, 60], mycelium: [111, 92, 100], farmland: [95, 65, 39],
    stone: [128, 128, 128], andesite: [136, 136, 133], diorite: [188, 188, 188], granite: [149, 103, 84],
    deepslate: [79, 79, 83], cobblestone: [122, 122, 122], mossy_cobblestone: [104, 118, 91],
    sand: [219, 207, 163], red_sand: [190, 102, 46], gravel: [136, 126, 122],
    sandstone: [219, 207, 163], red_sandstone: [180, 97, 44],
    water: [63, 118, 228], ice: [160, 188, 249], packed_ice: [141, 180, 250], blue_ice: [116, 164, 252],
    lava: [217, 89, 23],
    snow: [248, 248, 248], snow_block: [248, 248, 248], powder_snow: [248, 248, 250],
    netherrack: [113, 53, 53], soul_sand: [82, 63, 51], soul_soil: [78, 60, 48],
    basalt: [80, 80, 86], blackstone: [42, 36, 40], nether_bricks: [44, 22, 26],
    end_stone: [219, 217, 154], end_stone_bricks: [212, 210, 149], obsidian: [20, 18, 29],
    // Ores - most only matter underground, but cheap to add and helps a cave scan
    // read as more than a wall of uniform stone.
    coal_ore: [61, 61, 61], deepslate_coal_ore: [55, 55, 58],
    iron_ore: [156, 137, 118], deepslate_iron_ore: [141, 132, 128],
    copper_ore: [151, 118, 87], deepslate_copper_ore: [123, 111, 100],
    gold_ore: [143, 140, 88], deepslate_gold_ore: [135, 130, 100],
    redstone_ore: [130, 50, 40], deepslate_redstone_ore: [110, 55, 50],
    diamond_ore: [111, 168, 168], deepslate_diamond_ore: [104, 143, 143],
    emerald_ore: [79, 158, 88], deepslate_emerald_ore: [83, 138, 92],
    lapis_ore: [70, 101, 164], deepslate_lapis_ore: [79, 98, 143],
    ancient_debris: [99, 68, 57], nether_gold_ore: [141, 89, 42], nether_quartz_ore: [180, 168, 155],
    // Crops/farm features - common right around player bases.
    wheat: [201, 190, 74], carrots: [70, 140, 50], potatoes: [80, 130, 60],
    beetroots: [130, 40, 40], melon: [110, 140, 50], pumpkin: [190, 120, 30],
    sugar_cane: [130, 180, 90], cactus: [70, 120, 60], bamboo: [130, 160, 70],
    // Ocean/coral - flat stone-gray water floor otherwise.
    kelp: [55, 105, 40], seagrass: [60, 110, 55], prismarine: [99, 161, 148],
    prismarine_bricks: [99, 175, 164], dark_prismarine: [50, 84, 68], sea_lantern: [172, 207, 192],
    // Per-species wood, rather than one generic brown for every tree type.
    oak_planks: [162, 130, 78], oak_log: [102, 82, 52],
    spruce_planks: [114, 84, 48], spruce_log: [66, 54, 34],
    birch_planks: [196, 179, 123], birch_log: [216, 207, 196],
    jungle_planks: [160, 114, 80], jungle_log: [86, 66, 45],
    acacia_planks: [168, 90, 50], acacia_log: [103, 80, 58],
    dark_oak_planks: [67, 43, 20], dark_oak_log: [60, 44, 27],
    mangrove_planks: [117, 54, 44], mangrove_log: [83, 44, 40],
    cherry_planks: [226, 181, 180], cherry_log: [58, 42, 40],
    crimson_planks: [110, 64, 88], crimson_stem: [92, 25, 29],
    warped_planks: [43, 104, 99], warped_stem: [58, 95, 93]
};
// Wool/concrete/etc. all share the same 16 dye names and used to flatten to one
// gray regardless of actual color - real builds are often the first thing that
// makes a base recognizable on the map, so this was losing a lot of detail for
// free. glazed_terracotta uses these too (it's glossy/saturated, unlike plain
// terracotta below).
const DYE_COLORS = {
    white: [234, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179],
    light_blue: [58, 175, 217], yellow: [248, 198, 39], lime: [112, 185, 25],
    pink: [237, 141, 172], gray: [62, 68, 71], light_gray: [142, 142, 134],
    cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157],
    brown: [114, 71, 40], green: [84, 109, 27], red: [161, 39, 34], black: [20, 21, 25]
};
const DYE_SUFFIXES = ['wool', 'concrete', 'concrete_powder', 'carpet', 'banner', 'bed', 'stained_glass', 'stained_glass_pane', 'glazed_terracotta'];
function tryDyeColor(name) {
    for (const suffix of DYE_SUFFIXES) {
        if (name.endsWith('_' + suffix)) {
            const color = DYE_COLORS[name.slice(0, -(suffix.length + 1))];
            if (color) return color;
        }
    }
    return null;
}
// Plain terracotta is much more muted than the saturated dye colors above -
// this is what actually makes badlands/mesa terrain (like the lava-lake example)
// read as distinct strata instead of one flat gray.
const TERRACOTTA_COLORS = {
    plain: [152, 94, 68], white: [209, 178, 161], orange: [162, 84, 40], magenta: [149, 88, 108],
    light_blue: [113, 108, 137], yellow: [186, 133, 35], lime: [103, 118, 53], pink: [162, 78, 79],
    gray: [58, 42, 36], light_gray: [135, 106, 97], cyan: [87, 91, 91], purple: [118, 70, 86],
    blue: [74, 59, 91], brown: [77, 51, 35], green: [76, 83, 42], red: [143, 61, 46], black: [37, 23, 16]
};
function tryTerracottaColor(name) {
    if (name === 'terracotta') return TERRACOTTA_COLORS.plain;
    if (name.endsWith('_terracotta')) return TERRACOTTA_COLORS[name.slice(0, -'_terracotta'.length)] || null;
    return null;
}
function legacyColorForBlock(name) {
    if (!name) return [8, 8, 12]; // unloaded/unknown column
    if (BLOCK_COLORS[name]) return BLOCK_COLORS[name];
    const dye = tryDyeColor(name);
    if (dye) return dye;
    const terracotta = tryTerracottaColor(name);
    if (terracotta) return terracotta;
    if (name.endsWith('_leaves')) return [66, 104, 48];
    if (name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_stem') || name.endsWith('_hyphae')) return [96, 74, 48];
    if (name.endsWith('_planks')) return [162, 130, 78];
    return [90, 90, 90];
}

function uniformThumb(color) {
    return new Array(THUMB * THUMB).fill(color);
}

// Returns a THUMB x THUMB array of real [r,g,b] pixels for this block -
// either its real downsampled texture, its texture MASK multiply-blended
// per-pixel against the resolved biome tint (the same technique Minecraft
// itself uses for grass/leaves/water - finalPixel = maskPixel/255 * tint),
// or a uniform fill for curated/legacy flat colors. biomeName is only
// needed (and only looked up by the caller) when the resolved block
// actually requires tinting - most columns are stone/dirt/sand/etc, where
// a biome lookup would just be wasted work. name/biomeName are expected
// UNNAMESPACED (no "minecraft:" prefix), matching both blockTextureColors'
// own keys and mineflayer's registry block.name values.
function getBlockPixels(name, biomeName) {
    if (!name) return uniformThumb([8, 8, 12]); // unloaded/unknown column

    const entry = blockTextureColors[name];
    if (entry) {
        if (entry.tint) {
            const tints = (biomeName && biomeTints[biomeName]) || DEFAULT_TINT;
            const tintColor = tints[entry.tint] || DEFAULT_TINT[entry.tint];
            return entry.mask.map(([mr, mg, mb]) => [
                Math.round((mr / 255) * tintColor[0]),
                Math.round((mg / 255) * tintColor[1]),
                Math.round((mb / 255) * tintColor[2]),
            ]);
        }
        if (entry.texture) return entry.texture;
        if (entry.color) return uniformThumb(entry.color);
    }

    return uniformThumb(legacyColorForBlock(name));
}

// Whether getBlockPixels will actually use a biome for this block, without
// computing the pixels themselves - lets a scan loop skip a (cheap, but
// per-column) biome lookup for the common case.
function blockNeedsBiomeTint(name) {
    return !!(blockTextureColors[name] && blockTextureColors[name].tint);
}

module.exports = { THUMB, uniformThumb, getBlockPixels, blockNeedsBiomeTint, legacyColorForBlock };
