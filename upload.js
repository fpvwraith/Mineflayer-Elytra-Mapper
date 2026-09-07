#!/usr/bin/env node
// Batch-upload the tiles saved by the mapper to an ARGUS instance's mod-tile
// endpoint (POST /api/mod/upload-tile). Run it whenever you want to contribute
// what you've mapped: `node upload.js`. ARGUS de-dupes overlapping tiles on its
// side, so re-running is safe. URL + token come from config/env — never hardcoded.
//
// Requires Node 18+ (global fetch). Paced under ARGUS's rate limit (~60/min).
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');

const config = loadConfig();
const BASE = (config.upload && config.upload.argusUrl || '').replace(/\/+$/, '');
const TOKEN = config.upload && config.upload.token;
const LABEL = (config.upload && config.upload.label) || 'ARGUS Mapper';
const DELAY_MS = 1200; // ~50/min, comfortably under the server's 60/min limit
const outputDir = path.resolve(config.output.dir);
const manifestFile = path.join(outputDir, 'manifest.json');

if (!BASE || !TOKEN) {
  console.error('Set upload.argusUrl and upload.token in config.json (or ARGUS_UPLOAD_TOKEN env) first.');
  process.exit(1);
}
if (typeof fetch !== 'function') {
  console.error('This uploader needs Node 18+ (global fetch).');
  process.exit(1);
}
if (!fs.existsSync(manifestFile)) {
  console.error(`No manifest at ${manifestFile} — run the mapper first.`);
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const tiles = Object.values(manifest);
  console.log(`Uploading ${tiles.length} tiles to ${BASE}/api/mod/upload-tile ...`);
  let ok = 0, fail = 0;

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const filePath = path.join(outputDir, t.file);
    let png;
    try { png = fs.readFileSync(filePath); }
    catch (e) { console.warn(`  skip ${t.file}: ${e.message}`); fail++; continue; }

    const qs = new URLSearchParams({
      x: String(t.x), z: String(t.z), radius: String(t.radius),
      pixelSize: String(t.pixelSize || 8), label: LABEL,
    }).toString();

    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
      try {
        const res = await fetch(`${BASE}/api/mod/upload-tile?${qs}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
          body: png,
        });
        if (res.status === 204 || res.ok) { ok++; done = true; }
        else if (res.status === 429) { console.warn('  rate limited — backing off 30s'); await sleep(30000); }
        else if (res.status === 401) { console.error('  401 Unauthorized — check upload.token. Aborting.'); process.exit(1); }
        else { console.warn(`  ${t.file}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`); fail++; done = true; }
      } catch (e) {
        console.warn(`  ${t.file}: ${e.message} (attempt ${attempt}/3)`);
        if (attempt === 3) fail++; else await sleep(2000);
      }
    }

    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${tiles.length} (${ok} ok, ${fail} failed)`);
    await sleep(DELAY_MS);
  }

  console.log(`\nDone: ${ok} uploaded, ${fail} failed, of ${tiles.length}.`);
  console.log('Tiles remain in the output folder (re-uploading is safe). Delete output/ to start fresh.');
}

main().catch(e => { console.error(e); process.exit(1); });
