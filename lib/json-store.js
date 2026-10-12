const fs = require('fs');

// Tiny JSON helpers: atomic write (tmp + rename) and a read that never throws.

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
