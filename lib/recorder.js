'use strict';
// Chunk recorder: listens to the bot's chunk loads and hands every allowed chunk column to the Xaero region
// writer. Also flushes idle regions to disk and evicts them from memory so a long flight stays small.
const { columnFromPrismarine } = require('./xaero-writer');
const { regionOfChunk, regionAllowed, normalizeDimension } = require('./regions');

/**
 * @param {object} o
 * @param {object} o.writer        a writer from createWriter()
 * @param {object} o.guard         { skipSpawnRegions, maxAbsBlock }
 * @param {string} o.dimension     the dimension being recorded; chunks seen in another dimension are ignored
 * @param {function} [o.canRecord] () => boolean; false while in the proxy lobby / not on the main server
 * @param {function} [o.log]       log(msg)
 * @param {function} [o.onChunk]   ({cx, cz}) after a chunk was ingested
 * @param {function} [o.onRegion]  ({rx, rz, file, dimension}) after a region file was written
 * @param {number} [o.flushIdleMs] flush a region this long after its last new chunk (default 60 s)
 * @param {number} [o.evictIdleMs] forget a region this long after its last new chunk (default 5 min)
 */
function createRecorder(o) {
  const writer = o.writer;
  const log = o.log || (() => {});
  const guard = o.guard || {};
  const flushIdleMs = o.flushIdleMs ?? 60000;
  const evictIdleMs = o.evictIdleMs ?? 300000;
  const ceilingY = o.dimension === 'nether' ? 127 : undefined; // nether roof (unverified, see docs/xaero-format.md)
  const pending = new Map(); // "cx,cz" -> { bot, cx, cz }
  const lastSeen = new Map(); // "cx,cz" -> ms of last ingest (dedup of server re-sends)
  const stats = { chunksSeen: 0, chunksIngested: 0, skippedGuard: 0, skippedState: 0, errors: 0, regionsWritten: 0 };
  let scheduled = false, timer = null, closed = false;
  const flushedAt = new Map(); // "rx,rz" -> ms of last flush

  function schedule() {
    if (scheduled || closed) return;
    scheduled = true;
    setImmediate(drain);
  }

  // Ingest at most ~10 ms worth of chunks per slice so the bot's event loop (physics ticks) never starves.
  function drain() {
    scheduled = false;
    const t0 = Date.now();
    for (const [k, p] of pending) {
      pending.delete(k);
      ingest(p);
      if (Date.now() - t0 > 10) break;
    }
    if (pending.size) schedule();
  }

  function ingest({ bot, cx, cz }) {
    try {
      const rx = regionOfChunk(cx), rz = regionOfChunk(cz);
      if (!regionAllowed(rx, rz, guard)) { stats.skippedGuard++; return; }
      if (o.canRecord && !o.canRecord()) { stats.skippedState++; return; }
      const dim = normalizeDimension(bot.game && bot.game.dimension);
      if (dim && dim !== o.dimension) { stats.skippedState++; return; }
      const key = cx + ',' + cz;
      const last = lastSeen.get(key);
      if (last && Date.now() - last < 120000) return; // the server re-sent a chunk we just wrote
      const col = bot.world.getColumn(cx, cz);
      if (!col) return;
      const registry = bot.registry;
      const ok = writer.ingestChunk(cx, cz, (x, z) => columnFromPrismarine(col, x, z, { registry, ceilingY }));
      if (ok) {
        lastSeen.set(key, Date.now());
        stats.chunksIngested++;
        if (o.onChunk) o.onChunk({ cx, cz });
      }
    } catch (e) {
      stats.errors++;
      if (stats.errors <= 5 || stats.errors % 100 === 0) log(`recorder: chunk ${cx},${cz} failed: ${e.message}`);
    }
  }

  function onLoad(bot, p) {
    stats.chunksSeen++;
    // mineflayer's chunkColumnLoad carries the column's corner in BLOCK coordinates
    const cx = Math.floor(p.x) >> 4, cz = Math.floor(p.z) >> 4;
    pending.set(cx + ',' + cz, { bot, cx, cz });
    schedule();
  }

  function notify(files) {
    for (const f of files) {
      if (!f) continue;
      stats.regionsWritten++;
      const m = /(-?\d+)_(-?\d+)\.zip$/.exec(f);
      if (o.onRegion && m) o.onRegion({ rx: Number(m[1]), rz: Number(m[2]), file: f, dimension: o.dimension });
    }
  }

  async function housekeeping() {
    try {
      // flush regions that have been quiet for flushIdleMs (and are dirty), then evict very old ones
      const now = Date.now();
      for (const r of writer.regionsTouched()) {
        if (!r.dirty || now - r.lastIngest < flushIdleMs) continue;
        notify([await writer.flush(r.regionX, r.regionZ)]);
        flushedAt.set(r.regionX + ',' + r.regionZ, Date.now());
      }
      notify(await writer.evictOlderThan(evictIdleMs));
      if (lastSeen.size > 200000) { for (const [k, t] of lastSeen) if (now - t > 120000) lastSeen.delete(k); }
    } catch (e) {
      stats.errors++;
      log(`recorder: housekeeping failed: ${e.message}`);
    }
  }

  return {
    // Start listening to one bot (call again for each new bot after a reconnect).
    attach(bot) {
      const fn = (p) => onLoad(bot, p);
      bot.on('chunkColumnLoad', fn);
      if (!timer) { timer = setInterval(housekeeping, 5000); if (timer.unref) timer.unref(); }
      bot.once('end', () => { try { bot.removeListener('chunkColumnLoad', fn); } catch (e) { /* ignore */ } });
    },
    // Write everything still in memory (shutdown).
    async flushAll() {
      while (pending.size) drain();
      try { notify(await writer.flushAll()); } catch (e) { stats.errors++; log(`recorder: flush failed: ${e.message}`); }
    },
    async close() {
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
      pending.clear();
      await this.flushAll();
    },
    stats: () => ({ ...stats, ...writer.stats(), pending: pending.size }),
    _ingestForTest: ingest,
  };
}

module.exports = { createRecorder };
