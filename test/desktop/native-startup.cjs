// One focused production startup: first helper stalls before entering its script.
// No input injection, screenshot, teaching session or unrelated desktop scenarios.
const { app, BrowserWindow } = require('electron');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const realSpawn = childProcess.spawn;
const started = Date.now();
const helpers = [];
childProcess.spawn = function (command, args, options) {
  if (command !== 'powershell.exe') return realSpawn(command, args, options);
  const first = helpers.length === 0;
  if (first) args = [...args.slice(0, -1), `Start-Sleep -Seconds 30; ${args.at(-1)}`];
  const child = realSpawn(command, args, options);
  const record = { child, writes: 0, ready: false, beforeReady: 0, exited: false };
  if (!first) assert.ok(helpers[0].exited, 'replacement starts only after confirmed exit');
  helpers.push(record);
  console.log(`HELPER_PID:${child.pid}`);
  child.on('exit', () => (record.exited = true));
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('@READY\n') || stdout.includes('@READY\r\n')) record.ready = true;
  });
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (...values) => {
    record.writes++;
    if (!record.ready) record.beforeReady++;
    return write(...values);
  };
  return child;
};
process.on('exit', () => {
  for (const { child, exited } of helpers) if (!exited) child.kill();
});
require('../../dist/host/main.cjs');

async function run() {
  const home = process.env.TEACH_ME_AGENT_HOME;
  let endpoint;
  for (let n = 0; n < 450; n++) {
    try {
      endpoint = JSON.parse(await fs.readFile(path.join(home, 'endpoint.json'), 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(endpoint, 'production app reaches its endpoint after startup recovery');
  assert.equal(helpers.length, 2, 'exactly one startup replacement');
  assert.equal(helpers[0].writes, 0, 'stalled helper never receives a window operation');
  assert.equal(helpers[0].exited, true);
  assert.equal(helpers[1].ready, true);
  assert.equal(helpers[1].beforeReady, 0);
  assert.ok(helpers[1].writes >= 2, 'production panel and overlay policies completed');
  const panel = BrowserWindow.getAllWindows().find((window) =>
    window.webContents.getURL().includes('mode=panel'),
  );
  assert.ok(panel?.isVisible(), 'production panel is shown');
  console.log(
    `STARTUP_RECOVERED:${JSON.stringify({ elapsedMs: Date.now() - started, firstWrites: helpers[0].writes, replacementWrites: helpers[1].writes, beforeReady: helpers[1].beforeReady })}`,
  );
  // Stop immediately after the original startup scenario succeeds.
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-companion-token': endpoint.token },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, 'production stop succeeds');
  console.log('CHECKS_COMPLETE: startup recovery then immediate stop');
}
run().catch((error) => {
  console.error(error);
  for (const { child, exited } of helpers) if (!exited) child.kill();
  app.exit(1);
});
