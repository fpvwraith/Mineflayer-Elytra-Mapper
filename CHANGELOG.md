# Changelog

## 2.0.0

The mapper now saves **Xaero World Map compatible region files locally**. It does not upload anything.

### Added
- **Xaero World Map region output.** The mapper records the chunks it sees as `<rx>_<rz>.zip` region files
  (`output/regions/<dimension>/`), through a bundled writer (`lib/xaero-writer`) that merges with files already on disk,
  writes atomically and evicts idle regions to keep memory bounded.
- **`boxes` mode** (a list of rectangles) and an optional **`needed` mode**: plan flights from a public list of areas an
  ARGUS community map still lacks (one read-only GET of `<mapping.neededUrl>/api/needed-regions`; no account, nothing
  sent; off unless selected).
- **Guards**: `mapping.skipSpawnRegions` (default on) keeps the lobby area out of planning and recording;
  `limits.maxAbsBlock` (default 150000) bounds both.
- **Library API**: `createMapper(config)` (EventEmitter with `start`, `stop`, `status`, events `region`, `chunk`, `state`,
  `kicked`, `log`), `createRegionWriter`, `planBox`, `neededRegions` and more. Entry points `argus-elytra-mapper`,
  `/writer`, `/planner`.
- **CLI**: `argus-mapper` with `--dry-run`, `--config`, `--mode`, and `status` and `needed` commands.
- **Config validation** with one readable message per problem; `config.example.json` updated; `.env` support kept.
- **Memory**: configurable `server.viewDistance`, chunk pruning behind the bot, bounded region cache.
- **Connection**: anti-bot / captcha kick detection (the mapper stops, tells you, and waits `connection.captchaCooldownMin`;
  it never tries to solve it), readable kick reasons, configurable reconnect backoff with jitter.
- **Graceful shutdown** (SIGINT/SIGTERM and uncaught errors flush regions), `status.json` snapshot, structured JSON logs
  (`log.format`), `log.level`, secret scrubbing.
- Documentation in `docs/` and tests (`npm test`, Node's built-in test runner, no network or Minecraft needed).

### Changed
- PNG tiles are now optional and off by default (`output.tiles`); region zips are the main output.
- The server-specific numbers `mapping.noHomeRadius` and `mapping.homeCooldownSec` are configurable.
- Restart resume uses `coverage.json`, so ground flown without PNG tiles is skipped as well.
- Package renamed `argus-elytra-mapper`; the binary is `argus-mapper`.

### Removed / breaking
- **Uploading is gone.** v1's `upload.js` posted PNG tiles to `/api/mod/upload-tile`; that endpoint no longer exists, and
  this version has no upload code and no `upload` config section. The mapper only writes files to your disk.
- `node index.js` moved to `bin/argus-mapper.js` (`npm start` still works).

## 1.0.0

First public release: standalone elytra mapper writing PNG tiles, box mode, lawnmower planner.
