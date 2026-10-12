'use strict';
// Keeps memory flat on long flights. mineflayer keeps every chunk column it was ever sent, which grows without
// bound while the bot flies hundreds of thousands of blocks. The chunk recorder has already handed each column to the
// region writer by the time the bot is far away from it, so anything further than `keep` chunks is unloaded.
//
// `keep` must stay well outside what the server sends (view distance + a margin): unloading the newest row of chunks
// the moment it arrives is bad, because servers send each chunk only once.
function attachChunkPrune(bot, log, opts = {}) {
  const keep = opts.keep || 18;
  const everyMs = opts.everyMs || 5000;
  let dropped = 0, lastLog = Date.now(), lastPos = null, lastSpawnAt = 0;
  const onSpawn = () => { lastSpawnAt = Date.now(); };
  bot.on('spawn', onSpawn);
  bot.on('forcedMove', onSpawn);
  const timer = setInterval(() => {
    try {
      if (!bot.entity || !bot.world || typeof bot.world.getColumns !== 'function') return;
      // Only while flying, and not right after a jump (respawn, /home): pruning against the OLD position would
      // throw away the chunks that just arrived around the new one.
      const pos = bot.entity.position;
      const jumped = lastPos && Math.max(Math.abs(pos.x - lastPos.x), Math.abs(pos.z - lastPos.z)) > 500;
      lastPos = { x: pos.x, z: pos.z };
      if (bot.entity.onGround || jumped || Date.now() - lastSpawnAt < 30000) return;
      const cx = Math.floor(pos.x / 16), cz = Math.floor(pos.z / 16);
      for (const c of bot.world.getColumns()) {
        const x = +c.chunkX, z = +c.chunkZ;
        if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > keep) { bot.world.unloadColumn(x, z); dropped++; }
      }
      if (Date.now() - lastLog > 600000) {
        lastLog = Date.now();
        log(`chunk prune: dropped ${dropped} far chunks in 10 min, ${bot.world.getColumns().length} kept, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
        dropped = 0;
      }
    } catch (e) { /* never let housekeeping break the bot */ }
  }, everyMs);
  if (timer.unref) timer.unref();
  const detach = () => { clearInterval(timer); try { bot.removeListener('spawn', onSpawn); bot.removeListener('forcedMove', onSpawn); } catch (e) { /* ignore */ } };
  bot.once('end', detach);
  return detach;
}

module.exports = { attachChunkPrune };
