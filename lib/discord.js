// Optional Discord control + log mirror. Entirely opt-in (config.discord.enabled):
// a headless VPS run needs no Discord at all. Your OWN bot token and channel id
// come from config/env — nothing is hardcoded. Commands (in the configured
// channel only): `!map on [mode]`, `!map off`, `!map status`.
//
// discord.js is required lazily so if you don't use Discord you can install with
// `npm install --omit=optional` and never pull it in.
function createDiscord({ token, channelId }, { onCommand } = {}) {
  let Client, GatewayIntentBits;
  try {
    ({ Client, GatewayIntentBits } = require('discord.js'));
  } catch (e) {
    console.error('discord.enabled is true but the "discord.js" package is not installed. Run `npm install discord.js` or set discord.enabled=false.');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.on('error', (e) => console.error(`[discord] client error: ${e.message}`));

  // Batch log lines into one message every few seconds (avoids per-line rate limits).
  let buffer = [];
  let flushScheduled = false;
  const LIMIT = 1900;
  function flush() {
    flushScheduled = false;
    if (!buffer.length) return;
    const ch = client.channels.cache.get(channelId);
    const lines = buffer; buffer = [];
    if (!ch) return;
    let cur = '';
    const chunks = [];
    for (const l of lines) {
      const cand = cur ? `${cur}\n${l}` : l;
      if (cand.length > LIMIT) { if (cur) chunks.push(cur); cur = l; } else cur = cand;
    }
    if (cur) chunks.push(cur);
    chunks.forEach(t => ch.send(t).catch(err => console.error(`[discord] send failed: ${err.message}`)));
  }

  function log(text) {
    buffer.push(String(text));
    if (!flushScheduled) { flushScheduled = true; setTimeout(flush, 4000); }
  }

  client.on('messageCreate', (msg) => {
    if (msg.author.bot || msg.channelId !== channelId) return;
    const parts = msg.content.trim().split(/\s+/);
    if (parts[0] !== '!map') return;
    const sub = (parts[1] || '').toLowerCase();
    const arg = parts.slice(2).join(' ');
    try { if (onCommand) onCommand(sub, arg, (reply) => msg.reply(String(reply)).catch(() => {})); } catch (e) { console.error(`[discord] command error: ${e.message}`); }
  });

  function start() {
    client.once('clientReady', () => console.log(`[discord] connected as ${client.user.tag}, listening in channel ${channelId}`));
    // discord.js v14 uses 'ready'; v15 renames to 'clientReady' — bind both.
    client.once('ready', () => {});
    client.login(token).catch(e => { console.error(`[discord] login failed: ${e.message}`); });
  }

  return { start, log };
}

module.exports = { createDiscord };
