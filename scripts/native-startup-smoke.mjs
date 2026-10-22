import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const home = path.resolve('.runtime/native-startup', String(Date.now()));
await fs.mkdir(home, { recursive: true });
const env = { ...process.env, TEACH_ME_AGENT_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  createRequire(import.meta.url)('electron'),
  ['test/desktop/native-startup.cjs'],
  {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
const helperPids = () =>
  [...output.matchAll(/^HELPER_PID:(\d+)\r?$/gm)].map((match) => Number(match[1]));
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => (output += chunk));
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const ownedPids = () => [child.pid, ...helperPids()].filter(Boolean);
const waitForExit = async () => {
  for (let n = 0; n < 20 && ownedPids().some(alive); n++)
    await new Promise((resolve) => setTimeout(resolve, 100));
};
const failures = [];
try {
  const code = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('startup recovery timed out')), 55000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(deadline);
      resolve(code);
    });
  });
  await waitForExit();
  assert.ok(
    ownedPids().every((pid) => !alive(pid)),
    'all owned native helpers have exited',
  );
  assert.equal(code, 0, output);
  assert.match(output, /CHECKS_COMPLETE/);
  const log = await fs.readFile(path.join(home, 'runtime.log'), 'utf8');
  assert.match(log, /"event":"quit".*"exitCode":0/);
  assert.doesNotMatch(log, /"event":"startup-failed"/);
} catch (error) {
  failures.push(error);
} finally {
  // Cleanup is required even when a timeout or assertion fails. Forced cleanup
  // cannot turn a failed normal-exit assertion into a successful acceptance.
  for (const pid of ownedPids()) {
    try {
      if (alive(pid)) process.kill(pid);
    } catch (error) {
      if (error.code !== 'ESRCH') failures.push(error);
    }
  }
  try {
    await waitForExit();
    assert.ok(
      ownedPids().every((pid) => !alive(pid)),
      'fixture cleanup confirmed process exit',
    );
  } catch (error) {
    failures.push(error);
  }
  await fs.writeFile(path.join(home, 'fixture.log'), output);
}
if (failures.length) throw new AggregateError(failures, `startup fixture failed; evidence ${home}`);
console.log(`PASS: production startup recovered, app/helper processes exited; evidence ${home}`);
