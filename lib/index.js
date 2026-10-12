'use strict';
// Public library API of argus-elytra-mapper. See docs/library.md.
const pkg = require('../package.json');
const { createMapper } = require('./create-mapper');
const { createWriter, columnFromPrismarine, encodeRegion, decodeRegion, zipRegion, unzipRegion } = require('./xaero-writer');
const planner = require('./planner');
const regions = require('./regions');
const { resolveConfig, loadConfigFile, ConfigError, DEFAULTS } = require('./config');
const { kickText, classifyKick } = require('./connection');

module.exports = {
  VERSION: pkg.version,
  // the mapper
  createMapper,
  // Xaero region files
  createRegionWriter: createWriter, columnFromPrismarine, encodeRegion, decodeRegion, zipRegion, unzipRegion,
  // planning
  planBox: planner.planBox, boxRegions: planner.boxRegions, neededRegions: planner.neededRegions,
  parseNeeded: planner.parseNeeded, neededToBoxes: planner.neededToBoxes,
  // region maths and guards
  regionOfBlock: regions.regionOfBlock, regionAllowed: regions.regionAllowed, blockAllowed: regions.blockAllowed,
  isSpawnRegion: regions.isSpawnRegion, parseRegionName: regions.parseRegionName, normalizeDimension: regions.normalizeDimension,
  // config
  resolveConfig, loadConfigFile, ConfigError, DEFAULT_CONFIG: DEFAULTS,
  // kick helpers
  kickText, classifyKick,
};
