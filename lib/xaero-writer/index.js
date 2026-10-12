// Region writer: turns per-chunk column data into Xaero World Map 7.8 region files ("<rx>_<rz>.zip") that open in
// Xaero's World Map and are accepted by ARGUS-compatible community map servers. See docs/xaero-format.md.

const fs = require('fs');
const path = require('path');
const { encodeRegion, decodeRegion, zipRegion, unzipRegion } = require('./codec');
const { columnFromPrismarine } = require('./from-chunk');

const DIM_MIN_Y = { overworld: -64, nether: 0, end: 0 };
const NO_TOP = -32768;

// Columns are kept in compact typed arrays (about 4 KB per chunk, 4 MB for a fully seen region) rather than one
// object per column, so a long flight with many partially seen regions stays small.
class ChunkRec {
    constructor() {
        this.t = 0;                          // ingest time (ms), drives newest-wins against the disk file
        this.state = new Int32Array(256).fill(-1); // index into the writer's state table; -1 = column not seen
        this.height = new Int16Array(256);
        this.light = new Uint8Array(256);
        this.biome = new Int32Array(256).fill(-1);
        this.water = new Uint8Array(256);    // bit 0 water overlay; bits 4-7 overlay light
        this.depth = new Uint8Array(256);    // water depth -> overlay opacity
        this.top = new Int16Array(256).fill(NO_TOP);
    }
}

function createWriter({ outDir, dimension = 'overworld', minY } = {}) {
    if (!outDir) throw new Error('createWriter needs outDir');
    fs.mkdirSync(outDir, { recursive: true });
    const fillerY = minY ?? DIM_MIN_Y[dimension] ?? -64;
    const regions = new Map(); // "rx,rz" -> { rx, rz, chunks: Map(localChunk -> ChunkRec), lastIngest, dirty, ownMtime, lock }
    const stateTable = [], stateIndex = new Map(); // shared intern tables: a world has only a few thousand states
    const biomeTable = [], biomeIndex = new Map();

    function intern(table, index, key, value) {
        let i = index.get(key);
        if (i === undefined) { i = table.length; table.push(value); index.set(key, i); }
        return i;
    }

    function regionPath(rx, rz) { return path.join(outDir, `${rx}_${rz}.zip`); }

    // columnAccessor(x, z) is called with chunk-LOCAL x, z (0..15) and returns a column object (see codec.js) or
    // null/undefined for a column with no data (it then falls back to the disk file, or air filler - see docs/xaero-format.md).
    function ingestChunk(chunkX, chunkZ, columnAccessor) {
        const rx = chunkX >> 5, rz = chunkZ >> 5, key = rx + ',' + rz;
        const lc = ((chunkX & 31) << 5) | (chunkZ & 31);
        const rec = new ChunkRec();
        let seen = 0;
        for (let x = 0; x < 16; x++) {
            for (let z = 0; z < 16; z++) {
                const col = columnAccessor(x, z);
                if (!col || col.state == null) continue;
                const h = col.height;
                if (!Number.isInteger(h) || h < -2048 || h > 2047) throw new RangeError(`chunk ${chunkX},${chunkZ} col ${x},${z}: bad height ${h}`);
                const i = (x << 4) | z;
                const props = col.props && Object.keys(col.props).length ? col.props : null;
                const sk = (col.state.includes(':') ? col.state : 'minecraft:' + col.state) + (props ? JSON.stringify(props) : '');
                rec.state[i] = intern(stateTable, stateIndex, sk, { state: col.state, props });
                rec.height[i] = h;
                rec.light[i] = Math.max(0, Math.min(15, col.light | 0));
                rec.biome[i] = col.biome == null ? -1 : intern(biomeTable, biomeIndex, String(col.biome), String(col.biome));
                if (col.waterOverlay) {
                    rec.water[i] = 1 | (Math.max(0, Math.min(15, col.overlayLight | 0)) << 4);
                    const d = col.waterDepth != null ? col.waterDepth : (col.topHeight != null ? col.topHeight - h : 15);
                    rec.depth[i] = Math.max(1, Math.min(15, d | 0));
                }
                if (col.topHeight != null && col.topHeight !== h) rec.top[i] = col.topHeight;
                seen++;
            }
        }
        if (!seen) return false;
        let reg = regions.get(key);
        if (!reg) regions.set(key, reg = { rx, rz, chunks: new Map(), lastIngest: 0, dirty: false, ownMtime: null, lock: Promise.resolve() });
        const prev = reg.chunks.get(lc);
        if (prev && seen < 256) {
            // Re-seen chunk with gaps: keep what we knew for the columns the new pass could not read.
            for (let i = 0; i < 256; i++) {
                if (rec.state[i] >= 0 || prev.state[i] < 0) continue;
                rec.state[i] = prev.state[i]; rec.height[i] = prev.height[i]; rec.light[i] = prev.light[i];
                rec.biome[i] = prev.biome[i]; rec.water[i] = prev.water[i]; rec.depth[i] = prev.depth[i]; rec.top[i] = prev.top[i];
            }
        }
        rec.t = Date.now();
        reg.chunks.set(lc, rec);
        reg.lastIngest = rec.t;
        reg.dirty = true;
        return true;
    }

    function recColumn(rec, i) {
        if (rec.state[i] < 0) return null;
        const st = stateTable[rec.state[i]];
        const col = { state: st.state, height: rec.height[i], light: rec.light[i],
            biome: rec.biome[i] < 0 ? null : biomeTable[rec.biome[i]], waterOverlay: !!(rec.water[i] & 1),
            topHeight: rec.top[i] === NO_TOP ? null : rec.top[i] };
        if (st.props) col.props = st.props;
        if (col.waterOverlay) { col.waterDepth = rec.depth[i]; col.overlayLight = rec.water[i] >> 4; }
        return col;
    }

    function readDisk(file) {
        let st;
        try { st = fs.statSync(file); } catch (e) { return null; }
        try { return { columns: decodeRegion(unzipRegion(fs.readFileSync(file))), mtimeMs: st.mtimeMs }; } catch (e) {
            // Unreadable existing file: keep it aside instead of silently overwriting someone's data.
            const aside = `${file}.unreadable-${Date.now()}`;
            fs.renameSync(file, aside);
            return null;
        }
    }

    async function doFlush(reg) {
        const file = regionPath(reg.rx, reg.rz);
        const disk = readDisk(file);
        const columns = disk ? disk.columns : new Map();
        // Newest wins per column: memory beats the disk file unless the file was rewritten by someone else after the
        // chunk was ingested (our own last write never counts as newer).
        const diskIsOurs = disk && reg.ownMtime !== null && disk.mtimeMs === reg.ownMtime;
        for (const [lc, rec] of reg.chunks) {
            if (disk && !diskIsOurs && disk.mtimeMs > rec.t) continue;
            const baseX = (lc >> 5) << 4, baseZ = (lc & 31) << 4;
            for (let i = 0; i < 256; i++) {
                const col = recColumn(rec, i);
                if (col) columns.set(`${baseX + (i >> 4)},${baseZ + (i & 15)}`, col);
            }
        }
        const zipBuf = zipRegion(encodeRegion(columns, { minY: fillerY }));
        const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        await fs.promises.writeFile(tmp, zipBuf);
        await fs.promises.rename(tmp, file); // atomic replace on the same volume (MoveFileEx REPLACE_EXISTING on Windows)
        reg.ownMtime = fs.statSync(file).mtimeMs;
        return file;
    }

    // Serialised per region so two flushes of the same file never interleave.
    function flush(regionX, regionZ) {
        const reg = regions.get(regionX + ',' + regionZ);
        if (!reg) return Promise.resolve(null);
        const run = reg.lock.then(async () => {
            const startedAt = reg.lastIngest;
            const file = await doFlush(reg);
            if (reg.lastIngest === startedAt) reg.dirty = false; // stays dirty if chunks arrived mid-flush
            return file;
        });
        reg.lock = run.catch(() => {});
        return run;
    }

    async function flushAll() {
        const out = [];
        for (const reg of [...regions.values()]) if (reg.dirty) out.push(await flush(reg.rx, reg.rz));
        return out;
    }

    // Flush (if needed) and forget every region not ingested into for `ms` milliseconds. Returns flushed paths.
    async function evictOlderThan(ms) {
        const cutoff = Date.now() - ms, out = [];
        for (const [key, reg] of [...regions]) {
            if (reg.lastIngest > cutoff) continue;
            if (reg.dirty) out.push(await flush(reg.rx, reg.rz));
            if (reg.lastIngest <= cutoff) regions.delete(key); // re-check: an ingest may have landed during the flush
        }
        return out;
    }

    function regionsTouched() {
        return [...regions.values()].map(r => ({ regionX: r.rx, regionZ: r.rz, chunks: r.chunks.size, dirty: r.dirty, lastIngest: r.lastIngest, path: regionPath(r.rx, r.rz) }));
    }

    function stats() {
        let chunks = 0;
        for (const r of regions.values()) chunks += r.chunks.size;
        return { regions: regions.size, chunks, approxBytes: chunks * 256 * 16, states: stateTable.length, biomes: biomeTable.length };
    }

    return { ingestChunk, regionsTouched, flush, flushAll, evictOlderThan, stats, regionPath, dimension, minY: fillerY };
}

module.exports = { createWriter, columnFromPrismarine, encodeRegion, decodeRegion, zipRegion, unzipRegion, DIM_MIN_Y };
