import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { build } from 'esbuild';

const home = path.resolve('.runtime/html-lifecycle-smoke');
await fs.mkdir(home, { recursive: true });
await fs.rm(path.join(home, 'result.json'), { force: true });
await build({
  entryPoints: ['test/desktop/html-lifecycle-smoke.ts'],
  outfile: 'dist/test/html-lifecycle-smoke.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
const env = { ...process.env, TMA_HTML_LIFECYCLE_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  createRequire(import.meta.url)('electron'),
  ['dist/test/html-lifecycle-smoke.cjs'],
  {
    env,
    stdio: 'inherit',
    windowsHide: true,
  },
);
const deadline = setTimeout(() => {
  child.kill();
  console.error('HTML lifecycle smoke exceeded its 45-second deadline');
}, 45000);
child.on('error', (error) => {
  clearTimeout(deadline);
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', async (code, signal) => {
  clearTimeout(deadline);
  let passed = false;
  try {
    const result = JSON.parse(await fs.readFile(path.join(home, 'result.json'), 'utf8'));
    passed = result.passed && result.windowsRemaining === 0 && result.checks.length === 8;
  } catch {}
  if (code !== 0 || !passed)
    console.error(`HTML lifecycle smoke failed: exit=${code}, signal=${signal}, passed=${passed}`);
  process.exitCode = code === 0 && passed ? 0 : 1;
});
