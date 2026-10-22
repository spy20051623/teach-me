const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');

const source = (
  process.env.TMA_CLI_STARTUP_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:bin/teach-me.mjs'], { encoding: 'utf8' })
    : fs.readFileSync('bin/teach-me.mjs', 'utf8')
)
  .replace(/^#!.*\r?\n/, '')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', 'entryUrl');

async function run(readyAt, silent = false) {
  let elapsed = 0;
  let spawned = 0;
  let started = 0;
  let saved = 0;
  const errors = [];
  const proc = { argv: ['node', 'tma', 'start'], env: { TEACH_ME_AGENT_HOME: 'fixture' } };
  await vm.runInNewContext(`(async () => { ${source} })()`, {
    process: proc,
    path,
    os: require('node:os'),
    fileURLToPath,
    entryUrl: pathToFileURL(path.resolve('bin/teach-me.mjs')).href,
    createHash: require('node:crypto').createHash,
    randomUUID: () => 'fixture-secret',
    createRequire: () => () => 'fake-electron',
    Date: { now: () => elapsed },
    fs: {
      async readFile(file) {
        if (String(file).endsWith('endpoint.json') && elapsed >= readyAt)
          return JSON.stringify({ port: 12345, token: 'fixture-token' });
        throw new Error('not ready');
      },
      async mkdir() {},
      async access() {},
      async writeFile() {
        saved++;
      },
    },
    spawn() {
      spawned++;
      return { on() {}, unref() {} };
    },
    async postJson(_port, route, _headers, data, timeout) {
      if (route === 'start') {
        started++;
        assert.equal(data.launchSecret, 'fixture-secret');
        return { token: 'driver-token' };
      }
      assert.equal(route, 'status');
      if (silent) {
        elapsed += timeout;
        throw new Error('status timed out');
      }
      return {};
    },
    setTimeout(callback, delay) {
      elapsed += delay;
      queueMicrotask(callback);
    },
    console: { log() {}, error: (message) => errors.push(message) },
  });
  return { elapsed, spawned, started, saved, errors, code: proc.exitCode };
}

test('CLI waits through the bounded native startup recovery before starting a session', async () => {
  const result = await run(22000);
  assert.equal(result.code, undefined, result.errors.join('\n'));
  assert.equal(result.spawned, 1);
  assert.equal(result.started, 1);
  assert.equal(result.saved, 1);
  assert.ok(result.elapsed >= 22000 && result.elapsed < 23000);
});

test('CLI startup still terminates if the app never becomes ready', async () => {
  const result = await run(Infinity);
  assert.equal(result.code, 1);
  assert.equal(result.started, 0);
  assert.equal(result.saved, 0);
  assert.equal(result.spawned, 1);
  assert.ok(result.elapsed > 0 && result.elapsed <= 45000);
  assert.match(result.errors.join('\n'), /Electron 未能启动/);
});

test('a silent startup endpoint cannot extend the launch polling deadline', async () => {
  const result = await run(150, true);
  assert.equal(result.code, 1);
  assert.equal(result.started, 0);
  assert.equal(result.spawned, 1);
  assert.ok(result.elapsed > 0 && result.elapsed <= 45000);
});
