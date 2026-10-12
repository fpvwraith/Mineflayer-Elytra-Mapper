# Region files (Xaero World Map format)

The mapper writes `<rx>_<rz>.zip` files in the format of Xaero's World Map, version 7.8 (as written by Xaero World Map
1.45 on Minecraft 1.21.11). They are not a copy of anyone's Xaero cache: the writer rebuilds each map column from the
chunks the bot receives, using the same top-block rules Xaero uses. The result opens in Xaero's World Map and in
other Xaero-compatible tooling.

Output path: `output/regions/<dimension>/<rx>_<rz>.zip`. A region is 512 x 512 blocks (32 x 32 chunks);
`rx = floor(blockX / 512)`.

## File layout

A zip with one entry, `region.xaero`, deflated. The entry is big-endian:

| Part | Content |
|---|---|
| header | `0xFF`, then major `7` and minor `8` as two 16-bit integers |
| tiles | for each 64 x 64 block tile that has data, in ascending `tileX<<4 \| tileZ` order: that byte, then 16 chunks (`chunkX` 0 to 3 outer, `chunkZ` 0 to 3 inner) |
| chunk | `-1` (32-bit) when the chunk has no data, otherwise 256 pixels (`x` outer, `z` inner) and a trailer: interpretation version `1`, cave start `0x7FFFFFFF` (no cave layer), cave depth `30` |
| pixel | a 32-bit parameter word (grass flag, overlay flag, light, 12-bit signed height, biome and palette flags), then optional block-state NBT or palette index, top height byte, water overlay, biome name or palette index |

State and biome palettes are per file and fill in first-use order. The codec (`lib/xaero-writer/codec.js`) can both
write and read this format; reading is used to merge with a file that is already on disk.

## What is written

For each (x, z) column, the writer scans from the top of the build range down to the first block the map draws:

- Invisible blocks are skipped: air, barrier, light blocks, short and tall grass, large fern, tall seagrass, glass and
  glass panes, torches. Ferns, flowers, snow layers, leaves, vines, lily pads, carpets and saplings are drawn.
- Water (and bubble columns) becomes a water overlay with its depth; the block under the water is the base. Seagrass,
  kelp and waterlogged blocks are bases under a water overlay.
- Ice, stained glass, slime, honey and a few other translucent blocks are skipped, so the block below is used (ice over
  water reads as water). Packed ice and blue ice are normal top blocks.
- A column with nothing in it is `air` at the bottom of the world (an End void looks like this).
- Light is the block light just above the top block. Biome is the registry name of the biome at the top block.

## Merge and memory

- Columns are kept in typed arrays, about 4 KB per chunk; a fully seen region is about 4 MB until it is flushed.
- A flush reads the file on disk if there is one and lays the in-memory chunks over it, newest wins. A file somebody
  else rewrote after a chunk was seen is not overwritten by that older chunk.
- Writes are atomic (temporary file, then rename). If an existing file cannot be read it is renamed to
  `<name>.unreadable-<ms>` rather than overwritten.

## Known gaps

- Nether output (a roof-aware scan) was written from rules for the overworld and End and is not verified against real
  nether files.
- Rare blocks (rails, buttons, levers, chains, iron bars, skulls, candles) are treated as visible. If Xaero hides them,
  they appear as one block-coloured pixel.
- Cave layers, per-world cache files, colour types and slopes are not written.
- The top-height field stores 8 bits. Heights above 255 or below 0 are stored with their low byte.
