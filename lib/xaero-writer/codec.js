// Xaero World Map region codec, format 7.8 (Xaero World Map 1.45.0 / MC 1.21.11).
// encodeRegion writes the format a Xaero reader parses; decodeRegion is a
// small reader for the same format, used to merge with a region already on disk (it keeps block-state properties,
// which simpler readers drop). Layout checked against ~1,000 real region files written by Xaero (see docs/xaero-format.md).

const AdmZip = require('adm-zip');

const MAJOR = 7, MINOR = 8;
const ENTRY_NAME = 'region.xaero'; // the single entry every real <rx>_<rz>.zip holds
// Per-chunk trailer: identical in every real 7.8 chunk we looked at (55k+ chunks, all three dimensions).
const CHUNK_INTERP_VERSION = 1, CAVE_START_NONE = 0x7FFFFFFF, CAVE_DEPTH = 30;
const NO_CHUNK = -1;

function nsName(s) { return s.includes(':') ? s : 'minecraft:' + s; }
function stripNs(s) { return s && s.startsWith('minecraft:') ? s.slice(10) : s; }

// Xaero's "isNotGrass" bit: plain default grass_block is stored as a flag with no palette entry.
function isPlainGrass(col) {
    if (stripNs(col.state) !== 'grass_block') return false;
    const p = col.props;
    return !p || Object.keys(p).length === 0 || (Object.keys(p).length === 1 && String(p.snowy) === 'false');
}

// ---------- byte writer ----------
class ByteWriter {
    constructor(size = 1 << 16) { this.buf = Buffer.allocUnsafe(size); this.pos = 0; }
    ensure(n) {
        if (this.pos + n <= this.buf.length) return;
        let len = this.buf.length * 2; while (len < this.pos + n) len *= 2;
        const b = Buffer.allocUnsafe(len); this.buf.copy(b, 0, 0, this.pos); this.buf = b;
    }
    u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xFF; }
    i16(v) { this.ensure(2); this.buf.writeInt16BE(v, this.pos); this.pos += 2; }
    u16(v) { this.ensure(2); this.buf.writeUInt16BE(v, this.pos); this.pos += 2; }
    i32(v) { this.ensure(4); this.buf.writeInt32BE(v | 0, this.pos); this.pos += 4; }
    u32(v) { this.ensure(4); this.buf.writeUInt32BE(v >>> 0, this.pos); this.pos += 4; }
    bytes(b) { this.ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; }
    // Java DataOutput.writeUTF: 2-byte length + modified UTF-8 (NUL and astral chars encoded differently from UTF-8).
    mutf(s) {
        const out = [];
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i); // UTF-16 code unit, surrogates encoded separately (that is what Java does)
            if (c >= 1 && c <= 0x7F) out.push(c);
            else if (c <= 0x7FF) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
            else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
        }
        if (out.length > 0xFFFF) throw new Error('string too long for writeUTF');
        this.u16(out.length); this.bytes(Buffer.from(out));
    }
    result() { return this.buf.subarray(0, this.pos); }
}

// Block state as an uncompressed named-root NBT compound, byte-identical to what Xaero writes:
// TAG_Compound "" { [TAG_Compound "Properties" { TAG_String k: v ... }], TAG_String "Name": "ns:id" } - Properties
// first when present (that is the order in every real file).
function encodeStateNbt(name, props) {
    const w = new ByteWriter(64);
    w.u8(10); w.mutf('');
    const keys = props ? Object.keys(props) : [];
    if (keys.length) {
        w.u8(10); w.mutf('Properties');
        for (const k of keys) { w.u8(8); w.mutf(k); w.mutf(String(props[k])); }
        w.u8(0);
    }
    w.u8(8); w.mutf('Name'); w.mutf(nsName(name));
    w.u8(0);
    return w.result();
}

function stateKey(col) {
    const n = nsName(col.state);
    return col.props && Object.keys(col.props).length ? n + JSON.stringify(col.props) : n;
}

// columns: Map or iterable of ["gx,gz", column] (gx, gz region-local 0..511). Column fields:
//   state (required; 'stone' or 'minecraft:stone'), props {k: string}, height (int, -2048..2047), light 0..15,
//   biome ('plains' | 'minecraft:plains' | 'biomeID:n' | null), waterOverlay bool, topHeight (int|null; null when equal to height),
//   waterDepth (water blocks above the base, -> overlay opacity, capped 15), overlayLight 0..15.
// opts.minY: height used for the filler columns of a partially-known chunk (see docs/xaero-format.md).
function encodeRegion(columns, opts = {}) {
    const minY = opts.minY ?? -64;
    const grid = new Map(); // chunkKey (cx<<5|cz, region-local chunk coords) -> Array(256)
    for (const [key, col] of columns) {
        if (!col) continue;
        const c = key.indexOf(',');
        const gx = +key.slice(0, c), gz = +key.slice(c + 1);
        if (!(gx >= 0 && gx < 512 && gz >= 0 && gz < 512)) throw new RangeError(`column key out of range: ${key}`);
        const ck = ((gx >> 4) << 5) | (gz >> 4);
        let arr = grid.get(ck);
        if (!arr) grid.set(ck, arr = new Array(256).fill(null));
        arr[((gx & 15) << 4) | (gz & 15)] = col;
    }

    const w = new ByteWriter(1 << 20);
    w.u8(255); w.i16(MAJOR); w.i16(MINOR);
    const statePalette = new Map(), biomePalette = new Map();
    const filler = { state: 'air', height: minY, light: 0, biome: null };

    for (let tileX = 0; tileX < 8; tileX++) {
        for (let tileZ = 0; tileZ < 8; tileZ++) {
            // A tile (64x64 blocks = 4x4 chunks) is only written if one of its chunks has data; tiles go in ascending
            // (tileX<<4 | tileZ) order, as in every real file. The reader stops at EOF, so trailing tiles just end.
            let any = false;
            for (let i = 0; i < 16 && !any; i++) any = grid.has((((tileX << 2) | (i >> 2)) << 5) | ((tileZ << 2) | (i & 3)));
            if (!any) continue;
            w.u8((tileX << 4) | tileZ);
            for (let cx = 0; cx < 4; cx++) {
                for (let cz = 0; cz < 4; cz++) {
                    const arr = grid.get((((tileX << 2) | cx) << 5) | ((tileZ << 2) | cz));
                    if (!arr) { w.i32(NO_CHUNK); continue; }
                    for (let i = 0; i < 256; i++) writePixel(w, arr[i] || filler, statePalette, biomePalette);
                    w.u8(CHUNK_INTERP_VERSION); w.i32(CAVE_START_NONE); w.u8(CAVE_DEPTH);
                }
            }
        }
    }
    return Buffer.from(w.result());
}

function clampNibble(v) { v = v | 0; return v < 0 ? 0 : v > 15 ? 15 : v; }

function writePixel(w, col, statePalette, biomePalette) {
    const h = col.height;
    if (!Number.isInteger(h) || h < -2048 || h > 2047) throw new RangeError(`height ${h} not a 12-bit signed int`);
    const notGrass = isPlainGrass(col) ? 0 : 1;
    let stateIdx = -1, newState = 0;
    if (notGrass) {
        const k = stateKey(col);
        stateIdx = statePalette.get(k);
        if (stateIdx === undefined) { statePalette.set(k, statePalette.size); newState = 1; }
    }
    const biome = col.biome == null ? null : String(col.biome);
    const hasBiome = biome !== null ? 1 : 0;
    const biomeAsInt = hasBiome && biome.startsWith('biomeID:') ? 1 : 0;
    let biomeIdx = -1, newBiome = 0;
    if (hasBiome) {
        const bk = biomeAsInt ? biome : nsName(biome);
        biomeIdx = biomePalette.get(bk);
        if (biomeIdx === undefined) { biomePalette.set(bk, biomePalette.size); newBiome = 1; }
    }
    const water = col.waterOverlay ? 1 : 0;
    const th = col.topHeight;
    // Flag set whenever topHeight is given: the parser reports topHeight only when this flag was set, and the stored
    // byte can legitimately equal the height's low byte (seen in real files). Callers pass null when top == height.
    const thd = th != null ? 1 : 0;

    // Pixel parameter int, LSB first (Xaero 7.8 layout): 0 isNotGrass, 1 hasOverlays, 2-3 colorType (0 = none in 7.x),
    // 4 slope, 5 unused, 6 heightNOTinParams (always 0: height lives in bits 12-19 + 25-28), 8-11 light,
    // 12-19 height low byte, 20 hasBiome, 21 newStatePaletteEntry, 22 newBiomePaletteEntry, 23 biomeAsInt,
    // 24 topHeightAndHeightDontMatch, 25-28 height high nibble.
    const p = notGrass | (water << 1) | (clampNibble(col.light) << 8) | ((h & 0xFF) << 12) | (hasBiome << 20) |
        (newState << 21) | (newBiome << 22) | (biomeAsInt << 23) | (thd << 24) | (((h >> 8) & 0xF) << 25);
    w.u32(p);
    if (notGrass) {
        if (newState) w.bytes(encodeStateNbt(col.state, col.props));
        else w.i32(stateIdx);
    }
    if (thd) w.u8(th & 0xFF); // one byte only - the format stores the low 8 bits (see docs/xaero-format.md)
    if (water) {
        w.u8(1); // one overlay: water. Water overlays carry no state, colour or opacity int in 7.8.
        const depth = col.waterDepth != null ? col.waterDepth : (th != null ? th - h : 15);
        const opacity = Math.max(1, Math.min(15, depth | 0));
        // Overlay int: bit 0 0=water, 1-3 legacy/custom/hasOpacity flags (0), 4-7 light, 8-9 colorType,
        // 10 newStatePaletteEntry, 11-14 opacity (minor >= 8).
        w.u32((clampNibble(col.overlayLight) << 4) | (opacity << 11));
    }
    if (hasBiome) {
        if (newBiome) {
            if (biomeAsInt) w.i32(parseInt(biome.slice(8), 10));
            else w.mutf(nsName(biome));
        } else w.u32(biomeIdx);
    }
}

// ---------- reader (for merging with files already on disk) ----------
function readNbtStateAt(buf, pos) {
    // Minimal reader for the block-state compound shape above (also tolerates any other tag types by skipping them).
    let p = pos;
    const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
    const str = () => { const n = u16(); const s = buf.toString('utf8', p, p + n); p += n; return s; };
    const skipPayload = (t) => {
        switch (t) {
            case 1: p += 1; break; case 2: p += 2; break; case 3: case 5: p += 4; break; case 4: case 6: p += 8; break;
            case 7: p += 4 + buf.readInt32BE(p); break; case 8: p += 2 + buf.readUInt16BE(p); break;
            case 9: { const et = buf[p]; const n = buf.readInt32BE(p + 1); p += 5; for (let i = 0; i < n; i++) skipPayload(et); break; }
            case 10: for (;;) { const tt = buf[p++]; if (tt === 0) break; str(); skipPayload(tt); } break;
            case 11: p += 4 + 4 * buf.readInt32BE(p); break; case 12: p += 4 + 8 * buf.readInt32BE(p); break;
            default: throw new Error(`bad NBT tag ${t}`);
        }
    };
    if (buf[p++] !== 10) throw new Error('state NBT is not a compound');
    str();
    let name = 'minecraft:air', props = null;
    for (;;) {
        const t = buf[p++];
        if (t === 0) break;
        const key = str();
        if (t === 8 && key === 'Name') name = str();
        else if (t === 10 && key === 'Properties') {
            props = {};
            for (;;) { const tt = buf[p++]; if (tt === 0) break; const k = str(); if (tt === 8) props[k] = str(); else skipPayload(tt); }
        } else skipPayload(t);
    }
    return { size: p - pos, name, props };
}

// Returns Map "gx,gz" -> { state (namespace stripped,), props, height, light, biome, topHeight,
// waterOverlay, waterDepth, overlayLight }. Only 7.x files (palette biomes, no colour types) are supported.
function decodeRegion(buf) {
    let pos = 0;
    if (buf[0] !== 255) throw new Error('not a versioned region file');
    const major = buf.readInt16BE(1), minor = buf.readInt16BE(3); pos = 5;
    if (major < 4 || minor < 5) throw new Error(`unsupported region version ${major}.${minor}`);
    const states = [], biomes = [], out = new Map();
    while (pos < buf.length) {
        const cb = buf[pos++], tileX = cb >> 4, tileZ = cb & 15;
        for (let cx = 0; cx < 4; cx++) for (let cz = 0; cz < 4; cz++) {
            if (buf.readInt32BE(pos) === -1) { pos += 4; continue; }
            for (let px = 0; px < 16; px++) for (let pz = 0; pz < 16; pz++) {
                const p = buf.readUInt32BE(pos); pos += 4;
                const notGrass = p & 1, hasOv = (p >>> 1) & 1, inParams = !((p >>> 6) & 1);
                const light = (p >>> 8) & 15;
                let h = (p >>> 12) & 0xFF;
                const hasBiome = (p >>> 20) & 1, newState = (p >>> 21) & 1, newBiome = (p >>> 22) & 1, asInt = (p >>> 23) & 1;
                const thd = minor >= 4 ? (p >>> 24) & 1 : 0;
                if (inParams) { h |= ((p >>> 25) & 15) << 8; if (h & 0x800) h -= 4096; }
                let st = { name: 'minecraft:grass_block', props: null };
                if (notGrass) {
                    if (newState) { const r = readNbtStateAt(buf, pos); pos += r.size; st = r; states.push(r); }
                    else { st = states[buf.readInt32BE(pos)]; pos += 4; }
                }
                if (!inParams) h = buf[pos++];
                let topHeight = null;
                if (thd) topHeight = buf[pos++];
                let waterOverlay = false, waterDepth, overlayLight;
                if (hasOv) {
                    const n = buf[pos++];
                    for (let o = 0; o < n; o++) {
                        const ov = buf.readUInt32BE(pos); pos += 4;
                        const isWater = !(ov & 1), custom = (ov >>> 2) & 1, hasOpacity = (ov >>> 3) & 1;
                        if (isWater && !waterOverlay) { waterOverlay = true; waterDepth = minor >= 8 ? (ov >>> 11) & 15 : undefined; overlayLight = (ov >>> 4) & 15; }
                        if (!isWater) {
                            if ((ov >>> 10) & 1) { const r = readNbtStateAt(buf, pos); pos += r.size; states.push(r); } else pos += 4;
                        }
                        if (custom) pos += 4;
                        if (minor < 8 && hasOpacity) pos += 4;
                    }
                }
                let biome = null;
                if (hasBiome) {
                    if (newBiome) {
                        if (asInt) { biome = `biomeID:${buf.readInt32BE(pos)}`; pos += 4; }
                        else { const n = buf.readUInt16BE(pos); biome = stripNs(buf.toString('utf8', pos + 2, pos + 2 + n)); pos += 2 + n; }
                        biomes.push(biome);
                    } else { biome = biomes[buf.readUInt32BE(pos)]; pos += 4; }
                }
                const gx = (tileX << 6) | (cx << 4) | px, gz = (tileZ << 6) | (cz << 4) | pz;
                const col = { state: stripNs(st.name), height: h, light, biome, topHeight, waterOverlay };
                if (st.props) col.props = st.props;
                if (waterOverlay) { if (waterDepth != null) col.waterDepth = waterDepth; col.overlayLight = overlayLight; }
                out.set(`${gx},${gz}`, col);
            }
            pos += 1; // chunkInterpretationVersion
            pos += 4; if (minor >= 7) pos += 1; // caveStart, caveDepth
        }
    }
    if (pos !== buf.length) throw new Error(`region decode overran: ${pos} of ${buf.length}`);
    return out;
}

function zipRegion(raw) {
    const zip = new AdmZip();
    zip.addFile(ENTRY_NAME, raw);
    return zip.toBuffer();
}

function unzipRegion(zipBuf) {
    const zip = new AdmZip(zipBuf);
    const e = zip.getEntry(ENTRY_NAME) || zip.getEntries()[0];
    if (!e) throw new Error('empty region zip');
    return e.getData();
}

module.exports = { encodeRegion, decodeRegion, zipRegion, unzipRegion, encodeStateNbt, ENTRY_NAME, MAJOR, MINOR };
