// Resilient connection manager for a single mapping bot — extracted and slimmed
// from the ARGUS honeypot's bot-core, with all honeypot/stash/reward logic
// removed. Its whole job: keep a mineflayer bot alive and ON THE MAIN SERVER,
// and expose getBot()/isOnMainServer() for the mapper. Handles 6b6t's quirks:
// the proxy-lobby -> portal handoff, the reconfigure (backend-transfer) dance,
// corrupt-chunk parse errors, and rate-limit/captcha/DDoS kicks.
const mineflayer = require('mineflayer');
const { elytrafly } = require('mineflayer-elytrafly');

// Reconnect backoff: 15s, doubling to a 5-min cap, but only RESET after the
// connection has actually SURVIVED on the main server for HEALTHY_STABLE_MS.
// Resetting on arrival lets a corrupt-chunk crash loop reset every cycle and
// hammer the 15s floor forever; gating on real survival makes such a loop
// escalate to the cap and self-throttle instead.
const BASE_RECONNECT_DELAY_MS = 15000;
const MAX_RECONNECT_DELAY_MS = 300000;
const HEALTHY_STABLE_MS = 90000;

// A recoverable PARSE error (a corrupt chunk a vanilla client tolerates but
// node-minecraft-protocol can't) is NOT fatal — the deserializer re-pipes and
// packets are length-framed, so the socket survives. Log + skip instead of
// disconnecting; the 45s no-packet watchdog still catches a truly dead socket.
const RECOVERABLE_PARSE_RE = /Parse error|array size is abnormally large|Read error for|Chunk size|Deserialization error/i;
// 6b6t connection limiters that explicitly want you to wait — floor the backoff.
const RATE_LIMIT_KICK_RE = /logging in too fast|already online|connected account limit|DDoS Protection|Connection Blocked/i;
const RATE_LIMIT_MIN_DELAY_MS = 45000;
const CAPTCHA_KICK_RE = /anti bot protection|prove you're a human|verify\./i;
const CAPTCHA_MIN_DELAY_MS = 300000;

const MOVEMENT_PACKETS = new Set(['position', 'position_look', 'look']);

function createConnection({ config, log, onDeath, onMainServer }) {
  let bot = null;
  let reconnectDelay = BASE_RECONNECT_DELAY_MS;
  let reconnectScheduled = false;
  let manualStop = false;
  let parseSkipCount = 0;
  let lastParseSkipLoggedAt = 0;

  const server = config.server || {};
  const HOST = server.host || 'mc.6b6t.org';
  const PORT = server.port || 25565;
  const VERSION = server.version || '1.21.11';
  const AUTH = (config.account && config.account.auth) || 'offline';
  const USERNAME = config.account && config.account.username;
  const PASSWORD = config.account && config.account.loginPassword; // offline /login <pw>, from config (never hardcoded)
  const PROFILES = (config.account && config.account.profilesFolder) || './auth_cache';
  // Skip the 6b6t proxy-lobby -> portal dance for a normal server where you
  // spawn straight onto the main world.
  const DIRECT_CONNECT = !!server.directConnect;
  // 6b6t proxy-lobby bounding box (observed x~150-450, z~280-520). Override in
  // config for a different proxy layout.
  const LOBBY = server.lobbyBox || { minX: 150, maxX: 450, minZ: 280, maxZ: 520 };

  function isInsideLobby(pos) {
    if (!pos) return true;
    if (pos.x === 0 && pos.y === 0 && pos.z === 0) return true; // uninitialised
    return pos.x >= LOBBY.minX && pos.x <= LOBBY.maxX && pos.z >= LOBBY.minZ && pos.z <= LOBBY.maxZ;
  }

  function scheduleReconnect(reason) {
    if (reconnectScheduled || manualStop) return;
    reconnectScheduled = true;
    const delay = reconnectDelay;
    log(`🔌 ${reason} Reconnecting in ${Math.round(delay / 1000)}s...`);
    setTimeout(launch, delay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function cleanupTimers() {
    if (!bot || !bot.hp) return;
    if (bot.hp.portalHandoffTimeout) clearTimeout(bot.hp.portalHandoffTimeout);
    if (bot.hp.afkInterval) clearInterval(bot.hp.afkInterval);
    if (bot.hp.healthyResetTimer) clearTimeout(bot.hp.healthyResetTimer);
  }

  function launch() {
    reconnectScheduled = false;
    log('==================================================');
    log(`🚀 Connecting as ${USERNAME} to ${HOST}:${PORT} (${VERSION})`);
    try {
      const opts = { host: HOST, port: PORT, version: VERSION, hideErrors: true, checkTimeoutInterval: 45000 };
      if (AUTH === 'offline') { opts.username = USERNAME; opts.auth = 'offline'; }
      else { opts.auth = 'microsoft'; opts.username = USERNAME; opts.profilesFolder = PROFILES; }
      bot = mineflayer.createBot(opts);
      try { bot.loadPlugin(elytrafly); }
      catch (e) { log(`⚠️ failed to load elytrafly plugin: ${e.message}`); }
    } catch (err) {
      scheduleReconnect('Failed to init.');
      return;
    }

    bot.hp = { isOnMainServer: false, searchingPortal: false, portalHandoffTimeout: null, afkInterval: null, healthyResetTimer: null, lastPacketAt: Date.now(), expectedDeath: false };

    bot._client.on('packet', () => { if (bot.hp) bot.hp.lastPacketAt = Date.now(); });

    // Don't write movement packets while not in 'play' state (a physics-tick
    // position packet landing mid-reconfigure corrupts the stream and gets kicked).
    const rawWrite = bot._client.write.bind(bot._client);
    bot._client.write = function (name, params) {
      if (MOVEMENT_PACKETS.has(name) && bot._client.state !== 'play') return;
      return rawWrite(name, params);
    };
    bot._client.setMaxListeners(50);

    bot._client.on('start_configuration', () => {
      try { bot.clearControlStates(); } catch (e) {}
      bot.physicsEnabled = false;
    });
    bot._client.on('finish_configuration', () => {
      bot.physicsEnabled = true;
      try { bot._client.removeAllListeners('code_of_conduct'); } catch (e) {}
      if (bot.hp.portalHandoffTimeout) { clearTimeout(bot.hp.portalHandoffTimeout); bot.hp.portalHandoffTimeout = null; }
      bot.hp.searchingPortal = false;
      setTimeout(checkServerLocation, 1500);
    });

    bot.on('death', () => {
      if (!bot.hp.expectedDeath) log('☠️ died unexpectedly (something killed the bot).');
      bot.hp.expectedDeath = false;
      cleanupTimers();
      bot.physicsEnabled = false;
      try { if (onDeath) onDeath(); } catch (e) {}
      setTimeout(() => { try { if (bot) bot.respawn(); } catch (e) {} }, 3000);
    });

    bot.on('spawn', () => {
      if (AUTH === 'offline' && PASSWORD && !bot.hp.loggedIn) {
        bot.hp.loggedIn = true;
        setTimeout(() => { try { bot.chat(`/login ${PASSWORD}`); } catch (e) {} }, 1000);
      }
      setTimeout(checkServerLocation, 1500);
    });

    bot.on('end', () => {
      cleanupTimers();
      try { bot.quit(); } catch (e) {}
      if (!manualStop) scheduleReconnect('Disconnected.');
    });

    bot.on('error', (err) => {
      const msg = String((err && err.message) || err);
      if (RECOVERABLE_PARSE_RE.test(msg)) {
        parseSkipCount++;
        if (Date.now() - lastParseSkipLoggedAt > 60000) {
          lastParseSkipLoggedAt = Date.now();
          log(`🧩 skipped ${parseSkipCount} unparseable packet(s) (corrupt chunk) and stayed connected. Latest: ${msg.slice(0, 120)}`);
          parseSkipCount = 0;
        }
        return; // NOT fatal — the deserializer already re-piped
      }
      log(`Error: ${msg}`);
      try { bot.quit(); } catch (e) {}
      if (!manualStop) scheduleReconnect('Connection error.');
    });

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
      log(`Kicked: ${text}`);
      if (RATE_LIMIT_KICK_RE.test(text)) reconnectDelay = Math.max(reconnectDelay, RATE_LIMIT_MIN_DELAY_MS);
      if (CAPTCHA_KICK_RE.test(text)) {
        reconnectDelay = Math.max(reconnectDelay, CAPTCHA_MIN_DELAY_MS);
        log('🤖 Hit an anti-bot captcha — a human must clear it by logging into this account on a real client. Backing off.');
      }
      try { bot.quit(); } catch (e) {}
    });
  }

  // Decide whether we're in the proxy lobby (sprint to the portal) or on the
  // main server (ready to map). Re-run after every spawn and reconfigure hop.
  function checkServerLocation() {
    if (!bot || !bot.entity || bot.hp.searchingPortal) return;
    const pos = bot.entity.position;

    if (!DIRECT_CONNECT && isInsideLobby(pos)) {
      bot.hp.isOnMainServer = false;
      bot.hp.searchingPortal = true;
      bot.physicsEnabled = true;
      log(`Confirmed proxy lobby (X:${Math.round(pos.x)}, Z:${Math.round(pos.z)}). Sprinting to portal...`);
      if (bot.hp.afkInterval) { clearInterval(bot.hp.afkInterval); bot.hp.afkInterval = null; }
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      const onMove = () => {
        if (!bot || !bot.entity) return;
        const p = bot.entity.position;
        const feet = bot.blockAt(p);
        const head = bot.blockAt(p.offset(0, 1, 0));
        const isPortal = (b) => b && (b.name === 'portal' || b.name === 'nether_portal');
        if (isPortal(feet) || isPortal(head)) {
          bot.removeListener('move', onMove);
          log('Portal hit! Freezing physics for the proxy transfer.');
          try { bot.clearControlStates(); bot.physicsEnabled = false; } catch (e) {}
          bot.hp.portalHandoffTimeout = setTimeout(() => {
            if (!bot.hp.isOnMainServer) { log('⚠️ Portal handoff stalled (>45s). Restarting connection...'); try { bot.quit(); } catch (e) {} }
          }, 45000);
        }
      };
      bot.on('move', onMove);
      setTimeout(() => {
        if (bot) { bot.removeListener('move', onMove); try { bot.clearControlStates(); } catch (e) {} bot.hp.searchingPortal = false; checkServerLocation(); }
      }, 10000);
      return;
    }

    // ON THE MAIN SERVER
    bot.hp.isOnMainServer = true;
    bot.hp.searchingPortal = false;
    bot.physicsEnabled = true;
    if (bot.hp.portalHandoffTimeout) clearTimeout(bot.hp.portalHandoffTimeout);
    // Reset the backoff only after surviving HEALTHY_STABLE_MS on main — see the
    // const's comment. Scoped to THIS connection so a stale timer can't reset it
    // for a different, not-yet-stable one.
    if (bot.hp.healthyResetTimer) clearTimeout(bot.hp.healthyResetTimer);
    const healthyInstance = bot;
    bot.hp.healthyResetTimer = setTimeout(() => {
      if (bot === healthyInstance && bot.hp && bot.hp.isOnMainServer) {
        reconnectDelay = BASE_RECONNECT_DELAY_MS;
        log(`connection stable ${Math.round(HEALTHY_STABLE_MS / 1000)}s — reconnect backoff reset.`);
      }
    }, HEALTHY_STABLE_MS);

    log('✅ On main server.');
    try { if (onMainServer) onMainServer(); } catch (e) {}

    // Gentle anti-AFK look, in case the mapper is idle (paused/out of elytra).
    if (bot.hp.afkInterval) clearInterval(bot.hp.afkInterval);
    bot.hp.afkInterval = setInterval(() => {
      try { if (bot.entity && bot.physicsEnabled && !bot.hp.searchingPortal) bot.look(Math.random() * Math.PI * 2, 0); } catch (e) {}
    }, 120000);
  }

  return {
    start() { manualStop = false; launch(); },
    stop() { manualStop = true; try { if (bot) bot.quit(); } catch (e) {} },
    getBot: () => bot,
    isOnMainServer: () => !!(bot && bot.hp && bot.hp.isOnMainServer),
  };
}

module.exports = { createConnection };
