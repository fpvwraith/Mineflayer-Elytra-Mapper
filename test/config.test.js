'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveConfig, loadConfigFile, parseDotEnv, ConfigError } = require('../lib/config');
const { tmpDir, rmDir } = require('./helpers');

const ok = (over = {}, env = {}) => resolveConfig({ account: { username: 'TestBot' }, ...over }, { env });
const errs = (over, env = {}) => { try { resolveConfig(over, { env }); } catch (e) { assert.ok(e instanceof ConfigError); return e.errors.join('\n'); } assert.fail('expected a ConfigError'); };

test('defaults: regions on, tiles off, guards on, limit 150000', () => {
  const { config } = ok();
  assert.equal(config.output.regions, true);
  assert.equal(config.output.tiles, false);
  assert.equal(config.mapping.skipSpawnRegions, true);
  assert.equal(config.limits.maxAbsBlock, 150000);
  assert.equal(config.mapping.neededUrl, 'https://map.argus.tools');
  assert.equal(config.upload, undefined, 'there is no upload section');
});

test('a username is required, with a readable message', () => {
  assert.match(errs({}), /account\.username is required/);
});

test('env overrides win over the file for the login password', () => {
  const { config } = ok({ account: { username: 'a', loginPassword: 'FROM_FILE' } }, { MAPPER_LOGIN_PASSWORD: 'FROM_ENV' });
  assert.equal(config.account.loginPassword, 'FROM_ENV');
});

test('mode "box" needs a valid box and is normalised to box:x1,z1,x2,z2', () => {
  assert.match(errs({ account: { username: 'a' }, mapping: { mode: 'box' } }), /mapping\.box/);
  const { config } = ok({ mapping: { mode: 'box', box: { x1: 5000, z1: 6000, x2: 7000, z2: 8000 } } });
  assert.equal(config.mapping.mode, 'box:5000,6000,7000,8000');
});

test('mode "boxes" needs boxes; boxes may be objects or arrays', () => {
  assert.match(errs({ account: { username: 'a' }, mapping: { mode: 'boxes' } }), /mapping\.boxes is empty/);
  const { config } = ok({ mapping: { mode: 'boxes', boxes: [{ x1: 1, z1: 2, x2: 3, z2: 4 }, [5, 6, 7, 8]] } });
  assert.deepEqual(config.mapping.boxes, [[1, 2, 3, 4], [5, 6, 7, 8]]);
  assert.match(errs({ account: { username: 'a' }, mapping: { boxes: [[1, 2, 3]] } }), /every entry/);
});

test('unknown mode, bad types and ranges are reported together', () => {
  const msg = errs({ account: { username: 'a' }, mapping: { mode: 'sideways' }, mapping: { mode: 'sideways', neededUrl: 'ftp://x' }, output: { dimension: 'moon' }, limits: { maxAbsBlock: 'lots' } });
  assert.match(msg, /mapping\.mode "sideways"/);
  assert.match(msg, /mapping\.neededUrl/);
  assert.match(msg, /output\.dimension/);
  assert.match(msg, /limits\.maxAbsBlock/);
});

test('output.regions and output.tiles both false is an error', () => {
  assert.match(errs({ account: { username: 'a' }, output: { regions: false, tiles: false } }), /nothing would be saved/);
});

test('resolveConfig is idempotent', () => {
  const a = ok({ mapping: { mode: 'box', box: [1, 2, 3, 4] } }).config;
  assert.deepEqual(resolveConfig(a, { env: {} }).config, a);
});

test('parseDotEnv handles quotes and comments', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nB="two words"\nC=\'x\'\n bad line\n'), { A: '1', B: 'two words', C: 'x' });
});

test('loadConfigFile: missing file, invalid JSON, a good file with a .env next to it', () => {
  const dir = tmpDir();
  assert.throws(() => loadConfigFile(path.join(dir, 'nope.json')), /No config found/);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
  assert.throws(() => loadConfigFile(path.join(dir, 'bad.json')), /not valid JSON/);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ account: { username: 'FromFile' } }));
  fs.writeFileSync(path.join(dir, '.env'), 'MAPPER_LOGIN_PASSWORD=FAKE_TEST_PASSWORD\n');
  delete process.env.MAPPER_LOGIN_PASSWORD;
  const { config } = loadConfigFile(path.join(dir, 'config.json'));
  assert.equal(config.account.loginPassword, 'FAKE_TEST_PASSWORD');
  rmDir(dir);
});

test('config.example.json is valid', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  const { config } = resolveConfig(raw, { env: {} });
  assert.equal(config.account.username, 'YourBotAccountName');
});
