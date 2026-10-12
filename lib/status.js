'use strict';
// status.json: a small snapshot the CLI `argus-mapper status` (or any other tool) can read without talking to the
// running process. Written atomically on a timer.
const fs = require('fs');

function writeStatusFile(file, status) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, file);
}

function readStatusFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// One human-readable block for the CLI.
function formatStatus(s, now = Date.now()) {
  if (!s) return 'No status file yet. Is the mapper running (and is status.file the right path)?';
  const age = s.updatedAt ? Math.max(0, Math.round((now - Date.parse(s.updatedAt)) / 1000)) : null;
  const stale = age !== null && age > 120 ? `  (STALE: last written ${age} s ago, the mapper may not be running)` : '';
  const lines = [
    `connection : ${s.connection || '?'}${s.kick ? ` (last kick: ${s.kick.kind}: ${s.kick.reason})` : ''}${stale}`,
    `mapping    : ${s.mapping ? `${s.mapping.state} mode=${s.mapping.mode} active=${s.mapping.active} covered=${s.mapping.covered}/${s.mapping.waypoints}` : '?'}`,
    `position   : ${s.mapping && s.mapping.pos ? `${s.mapping.pos.x}, ${s.mapping.pos.y}, ${s.mapping.pos.z}` : '?'}`,
    `recorder   : ${s.recorder ? `${s.recorder.chunksIngested} chunks, ${s.recorder.regionsWritten} region writes, ${s.recorder.regions} in memory` : '?'}`,
    `output     : ${s.output ? `${s.output.regionFiles} region files in ${s.output.regionsDir}` : '?'}`,
  ];
  if (s.memory) lines.push(`memory     : rss ${s.memory.rssMb} MB`);
  if (s.lastError) lines.push(`last error : ${s.lastError}`);
  if (age !== null) lines.push(`updated    : ${s.updatedAt} (${age} s ago)`);
  return lines.join('\n');
}

module.exports = { writeStatusFile, readStatusFile, formatStatus };
