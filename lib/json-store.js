const fs = require('fs');

// Extracted from bot-core.js so the web server (which can't reach into that
// module's closure - it only exports the createHoneypotBot factory) can reuse
// the exact same read/write behavior instead of a second, potentially
// drifting copy. Bodies are unchanged from the originals.

function writeJsonAtomic(filePath, data) {
    try {
        const tmp = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filePath);
    } catch (e) {
        console.error(`[STATE] Failed to write ${filePath}: ${e.message}`);
    }
}

function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

module.exports = { writeJsonAtomic, readJsonSafe };
