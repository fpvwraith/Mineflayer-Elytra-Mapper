'use strict';
// Small structured logger: text or JSON lines, level filter, optional file, secret scrubbing.
const fs = require('fs');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * @param {object} o
 * @param {string} [o.level]     error | warn | info | debug (default info)
 * @param {string} [o.format]    text | json (default text)
 * @param {string|null} [o.file] also append to this file
 * @param {string[]} [o.secrets] strings that must never appear in the output (tokens, passwords)
 * @param {function} [o.sink]    extra consumer, called with {time, level, msg} for entries that pass the filter
 * @param {boolean} [o.console]  write to stdout/stderr (default true)
 */
function createLogger(o = {}) {
  const threshold = LEVELS[o.level] ?? LEVELS.info;
  const json = o.format === 'json';
  const secrets = (o.secrets || []).filter((s) => s && String(s).length >= 4).map(String);
  const toConsole = o.console !== false;
  let stream = null;
  if (o.file) {
    try { stream = fs.createWriteStream(o.file, { flags: 'a' }); stream.on('error', () => { stream = null; }); } catch (e) { stream = null; }
  }

  function scrub(text) {
    let t = String(text);
    for (const s of secrets) t = t.split(s).join('***');
    return t;
  }

  function write(level, msg, fields) {
    if (LEVELS[level] > threshold) return;
    const entry = { time: new Date().toISOString(), level, msg: scrub(typeof msg === 'string' ? msg : (msg && msg.message) || String(msg)) };
    if (fields && typeof fields === 'object') Object.assign(entry, JSON.parse(scrub(JSON.stringify(fields))));
    const line = json ? JSON.stringify(entry) : `${entry.time} [${level}] ${entry.msg}`;
    if (toConsole) (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    if (stream) stream.write(line + '\n');
    if (o.sink) { try { o.sink(entry); } catch (e) { /* sink errors must not break logging */ } }
  }

  return {
    error: (m, f) => write('error', m, f),
    warn: (m, f) => write('warn', m, f),
    info: (m, f) => write('info', m, f),
    debug: (m, f) => write('debug', m, f),
    // The mapper's free-form log lines: warnings and problems get level warn, the rest info.
    line: (m) => write(/^(⚠|☠|🤖|Error|Kicked|\[FATAL\])/.test(String(m)) ? 'warn' : 'info', m),
    scrub,
    close() { if (stream) { stream.end(); stream = null; } },
  };
}

module.exports = { createLogger, LEVELS };
