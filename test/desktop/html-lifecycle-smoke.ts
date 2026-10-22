import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HtmlHost } from '../../src/host/html.ts';

const home = path.resolve(process.env.TMA_HTML_LIFECYCLE_HOME || '.runtime/html-lifecycle-smoke');
app.setPath('userData', path.join(home, 'profile'));
app.setName('Teach me HTML lifecycle acceptance');
app.on('window-all-closed', () => {});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(check: () => boolean, description: string, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start >= timeout) throw new Error(`Timed out: ${description}`);
    await pause(20);
  }
}
async function promptly<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Cancellation did not settle within 1000ms')),
        1000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
type Outcome = { ok: true } | { ok: false; error: unknown };
const outcome = (promise: Promise<void>): Promise<Outcome> =>
  promise.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
const checks: { name: string; injection: string; elapsedMs: number }[] = [];
async function check(
  name: string,
  injection: string,
  run: (host: HtmlHost, notices: string[]) => Promise<void>,
) {
  const notices: string[] = [];
  const host = new HtmlHost((reason) => notices.push(reason));
  const started = Date.now();
  try {
    await run(host, notices);
    checks.push({ name, injection, elapsedMs: Date.now() - started });
    console.log(`PASS ${name}`);
  } finally {
    host.clear();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
  }
}
function begin(host: HtmlHost, injection?: (window: BrowserWindow) => void, ttl = 15000) {
  let created: BrowserWindow | undefined;
  const listener = (_event: Electron.Event, window: BrowserWindow) => {
    created = window;
    injection?.(window);
  };
  app.once('browser-window-created', listener);
  const display = screen.getPrimaryDisplay();
  const result = outcome(
    host.show(
      {
        type: 'html',
        rect: [20, 20, 250, 120],
        html: '<div data-fixture="html-lifecycle">Isolated lifecycle verification</div>',
        ttl,
      },
      display,
    ),
  );
  app.removeListener('browser-window-created', listener);
  assert.ok(created, 'real BrowserWindow was created synchronously');
  assert.equal(created.isFocusable(), false);
  return { result, window: created };
}
async function loaded(host: HtmlHost) {
  const next = begin(host);
  assert.equal((await next.result).ok, true);
  await until(() => next.window.isVisible(), 'real HTML window visible after loading');
  assert.ok(next.window.webContents.getURL().startsWith('data:text/html'));
  assert.equal(next.window.isFocused(), false);
  return next.window;
}

async function run() {
  await app.whenReady();
  await check(
    'load rejection destroys real window and next real load recovers',
    'loadURL rejects with a fixture error',
    async (host) => {
      const failure = new Error('injected HTML load rejection');
      const old = begin(host, (window) => {
        window.loadURL = () => Promise.reject(failure);
      });
      const result = await old.result;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error, failure);
      assert.equal(old.window.isDestroyed(), true);
      await loaded(host);
    },
  );
  await check(
    'ten-second hanging load closes real window and releases show',
    'loadURL returns a pending promise',
    async (host) => {
      const gate = deferred();
      const started = Date.now();
      const old = begin(host, (window) => {
        window.loadURL = () => gate.promise;
      });
      const result = await old.result;
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(String(result.error), /加载超时/);
      assert.ok(Date.now() - started >= 9500);
      assert.ok(Date.now() - started < 14000);
      assert.equal(old.window.isDestroyed(), true);
      const current = await loaded(host);
      gate.resolve();
      await pause(100);
      assert.equal(current.isDestroyed(), false);
    },
  );
  await check(
    'clear promptly cancels pending show and supports another real load',
    'old loadURL waits on a controlled promise',
    async (host) => {
      const gate = deferred();
      const old = begin(host, (window) => {
        window.loadURL = () => gate.promise;
      });
      host.clear();
      assert.equal((await promptly(old.result)).ok, false);
      assert.equal(old.window.isDestroyed(), true);
      const current = await loaded(host);
      gate.resolve();
      await pause(100);
      assert.equal(current.isDestroyed(), false);
      assert.equal(current.isVisible(), true);
    },
  );
  await check(
    'replacement cancels old show and ignores late old rejection',
    'old loadURL later rejects; replacement loads real data URL',
    async (host) => {
      const gate = deferred();
      const old = begin(host, (window) => {
        window.loadURL = () => gate.promise;
      });
      const next = begin(host);
      assert.equal((await promptly(old.result)).ok, false);
      assert.equal(old.window.isDestroyed(), true);
      assert.equal((await next.result).ok, true);
      gate.reject(new Error('injected obsolete rejection'));
      await pause(100);
      assert.equal(next.window.isDestroyed(), false);
      assert.equal(next.window.isVisible(), true);
    },
  );
  await check(
    'hide during loading stays hidden after real load and can show later',
    'real loadURL is delayed by a controlled promise',
    async (host) => {
      const gate = deferred();
      const next = begin(host, (window) => {
        const original = window.loadURL.bind(window);
        window.loadURL = (url, options) => gate.promise.then(() => original(url, options));
      });
      host.visible(false);
      assert.equal(next.window.isVisible(), false);
      gate.resolve();
      assert.equal((await next.result).ok, true);
      await pause(100);
      assert.equal(next.window.isVisible(), false);
      host.visible(true);
      await until(() => next.window.isVisible(), 'explicit reveal after hidden load');
      host.visible(false);
      await until(() => !next.window.isVisible(), 'explicit hide after ready');
    },
  );
  await check(
    'show during loading never reveals the unready real window',
    'real loadURL is delayed by a controlled promise',
    async (host) => {
      const gate = deferred();
      const next = begin(host, (window) => {
        const original = window.loadURL.bind(window);
        window.loadURL = (url, options) => gate.promise.then(() => original(url, options));
      });
      host.visible(true);
      await pause(100);
      assert.equal(next.window.isVisible(), false);
      gate.resolve();
      assert.equal((await next.result).ok, true);
      await until(() => next.window.isVisible(), 'ready window reveal');
      assert.equal(next.window.isFocused(), false);
    },
  );
  await check(
    'normal real HTML expires at TTL and releases its window',
    'none',
    async (host, notices) => {
      const next = begin(host, undefined, 1000);
      assert.equal((await next.result).ok, true);
      assert.equal(next.window.isContentProtected(), true);
      await until(() => next.window.isDestroyed(), 'TTL window destruction', 2500);
      assert.deepEqual(notices, ['']);
    },
  );
  await check(
    'two excessive resource samples close the real HTML renderer',
    'app.getAppMetrics reports CPU 90% for the actual renderer PID',
    async (host, notices) => {
      const original = app.getAppMetrics.bind(app);
      const window = await loaded(host);
      const pid = window.webContents.getOSProcessId();
      let observations = 0;
      app.getAppMetrics = () =>
        original().map((metric) => {
          if (metric.pid !== pid) return metric;
          observations++;
          return { ...metric, cpu: { ...metric.cpu, percentCPUUsage: 90 } };
        });
      try {
        await until(() => window.isDestroyed(), 'resource watchdog destruction', 3500);
        assert.ok(observations >= 2);
        assert.ok(notices.some((notice) => notice.includes('占用过高')));
      } finally {
        app.getAppMetrics = original;
      }
    },
  );
}

let exitCode = 0;
run()
  .catch((error) => {
    exitCode = 1;
    console.error(error);
  })
  .finally(async () => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, 'result.json'),
      JSON.stringify(
        {
          passed: exitCode === 0,
          checks,
          windowsRemaining: BrowserWindow.getAllWindows().length,
          boundary:
            'Real Windows Electron windows and renderer loads; injected load failures/delays and resource metrics. No keyboard, mouse, external focus control, or screenshot/visual review.',
        },
        null,
        2,
      ),
    );
    app.exit(exitCode);
  });
