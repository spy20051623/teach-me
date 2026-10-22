const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');

// Execute the complete adapter with synthetic windows only. No Electron startup,
// renderer, operating-system process, network, or real document load is allowed.
const compiled = buildSync({
  entryPoints: [path.join(__dirname, '../src/host/html.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  write: false,
  logLevel: 'silent',
}).outputFiles[0].text;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function settled(promise) {
  const marker = Symbol('pending');
  const result = await Promise.race([promise, turn().then(() => marker)]);
  assert.notEqual(result, marker, 'show must settle without waiting for its obsolete loadURL');
  return result;
}
function setup(t, faults = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const windows = [];
  const notices = [];
  let metrics = [];
  class SyntheticWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.id = windows.length + 1;
      this.loading = deferred();
      this.destroyed = false;
      this.visible = false;
      this.showCalls = 0;
      this.destroyCalls = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        getOSProcessId: () => this.id,
        session: Object.assign(new EventEmitter(), {
          webRequest: { onBeforeRequest() {} },
        }),
      });
      windows.push(this);
    }
    setContentProtection(value) {
      this.protected = value;
    }
    setAlwaysOnTop() {
      if (faults.setupError) throw faults.setupError;
    }
    setIgnoreMouseEvents() {}
    loadURL(url) {
      this.url = url;
      return this.loading.promise;
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.showCalls++;
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyCalls++;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'electron')
        return {
          BrowserWindow: SyntheticWindow,
          app: {
            getAppMetrics: () => {
              if (faults.metricsError) throw faults.metricsError;
              return metrics;
            },
          },
        };
      if (name === 'node:crypto') return require(name);
      throw new Error(`forbidden HTML fixture module: ${name}`);
    },
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const host = new module.exports.HtmlHost((message) => notices.push(message));
  const start = (ttl = 15000) =>
    host
      .show(
        { type: 'html', rect: [10, 20, 200, 100], html: '<p>synthetic fixture</p>', ttl },
        { bounds: { x: 0, y: 0, width: 1000, height: 800 } },
      )
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
  t.after(async () => {
    host.clear();
    for (const window of windows) window.loading.resolve();
    await turn();
    t.mock.timers.reset();
  });
  return {
    host,
    windows,
    notices,
    start,
    metrics: (value) => {
      metrics = value;
    },
  };
}

test('HTML load rejection destroys its window and a later show can recover', async (t) => {
  const h = setup(t);
  const pending = h.start();
  const old = h.windows[0];
  const failure = new Error('fixture load failed');
  old.loading.reject(failure);
  const result = await settled(pending);
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  assert.equal(old.destroyed, true);
  assert.equal(old.showCalls, 0);
  const next = h.start();
  const current = h.windows[1];
  current.loading.resolve();
  assert.equal((await settled(next)).ok, true);
  assert.equal(current.visible, true);
});

test('HTML loading has a ten-second deadline and its late completion cannot affect a replacement', async (t) => {
  const h = setup(t);
  const pending = h.start();
  const old = h.windows[0];
  t.mock.timers.tick(9999);
  await turn();
  assert.equal(old.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal((await settled(pending)).ok, false);
  assert.equal(old.destroyed, true);
  const next = h.start();
  const current = h.windows[1];
  current.loading.resolve();
  assert.equal((await settled(next)).ok, true);
  old.loading.resolve();
  await turn();
  assert.equal(current.destroyed, false);
  assert.equal(current.visible, true);
  assert.equal(old.showCalls, 0);
});

test('clearing a loading HTML window promptly rejects show and ignores its late success', async (t) => {
  const h = setup(t);
  const pending = h.start();
  const old = h.windows[0];
  h.host.clear();
  assert.equal(old.destroyed, true);
  assert.equal((await settled(pending)).ok, false);
  old.loading.resolve();
  await turn();
  t.mock.timers.tick(60000);
  assert.equal(old.showCalls, 0);
  assert.equal(old.destroyCalls, 1);
  assert.deepEqual(h.notices, []);
});

test('replacing a loading HTML window promptly rejects old show and ignores its late rejection', async (t) => {
  const h = setup(t);
  const oldPending = h.start();
  const old = h.windows[0];
  const next = h.start();
  const current = h.windows[1];
  assert.equal((await settled(oldPending)).ok, false);
  assert.equal(old.destroyed, true);
  current.loading.resolve();
  assert.equal((await settled(next)).ok, true);
  old.loading.reject(new Error('obsolete fixture load error'));
  await turn();
  assert.equal(current.destroyed, false);
  assert.equal(current.visible, true);
  assert.equal(old.showCalls, 0);
});

test('hiding HTML while it loads keeps the completed window hidden until explicitly shown', async (t) => {
  const h = setup(t);
  const pending = h.start();
  const window = h.windows[0];
  h.host.visible(false);
  window.loading.resolve();
  assert.equal((await settled(pending)).ok, true);
  assert.equal(window.visible, false);
  assert.equal(window.showCalls, 0);
  h.host.visible(true);
  assert.equal(window.visible, true);
  assert.equal(window.showCalls, 1);
});

test('showing HTML while loading does not expose an unready window', async (t) => {
  const h = setup(t);
  const pending = h.start();
  const window = h.windows[0];
  h.host.visible(true);
  assert.equal(window.visible, false);
  assert.equal(window.showCalls, 0);
  window.loading.resolve();
  assert.equal((await settled(pending)).ok, true);
  assert.equal(window.visible, true);
  assert.equal(window.showCalls, 1);
});

test('ready HTML keeps its TTL and capture protection behavior', async (t) => {
  const h = setup(t);
  const pending = h.start(2000);
  const window = h.windows[0];
  assert.equal(window.protected, true);
  h.host.setCaptureVisible(true);
  assert.equal(window.protected, false);
  window.loading.resolve();
  assert.equal((await settled(pending)).ok, true);
  t.mock.timers.tick(1999);
  assert.equal(window.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(window.destroyed, true);
  assert.deepEqual(h.notices, ['']);
});

test('HTML resource watchdog requires consecutive overload and recovers after a low sample', async (t) => {
  const h = setup(t);
  const pending = h.start(60000);
  const window = h.windows[0];
  window.loading.resolve();
  assert.equal((await settled(pending)).ok, true);
  const load = (percent) =>
    h.metrics([
      { pid: window.id, memory: { workingSetSize: 1024 }, cpu: { percentCPUUsage: percent } },
    ]);
  load(90);
  t.mock.timers.tick(1000);
  assert.equal(window.destroyed, false);
  load(0);
  t.mock.timers.tick(1000);
  load(90);
  t.mock.timers.tick(1000);
  assert.equal(window.destroyed, false);
  t.mock.timers.tick(1000);
  assert.equal(window.destroyed, true);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /占用过高/);
});

test('synchronous HTML setup failure closes its window, preserves the error and permits retry', async (t) => {
  const failure = new Error('fixture window setup failure');
  const faults = { setupError: failure };
  const h = setup(t, faults);
  const result = await settled(h.start());
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  const old = h.windows[0];
  assert.equal(old.destroyed, true);
  assert.equal(old.showCalls, 0);
  delete faults.setupError;
  const next = h.start();
  const current = h.windows[1];
  current.loading.resolve();
  assert.equal((await settled(next)).ok, true);
  t.mock.timers.tick(10001);
  assert.equal(current.destroyed, false, 'the failed load deadline cannot close its replacement');
  assert.equal(current.visible, true);
  assert.equal(old.destroyCalls, 1);
});

for (const event of ['closed', 'render-process-gone']) {
  test(`HTML ${event} during loading settles show and isolates late events from its replacement`, async (t) => {
    const h = setup(t);
    const pending = h.start();
    const old = h.windows[0];
    if (event === 'closed') {
      old.destroyed = true;
      old.emit('closed');
    } else old.webContents.emit('render-process-gone');
    assert.equal((await settled(pending)).ok, false);
    assert.equal(old.destroyed, true);
    assert.equal(old.showCalls, 0);
    assert.equal(h.notices.length, 1);
    const next = h.start();
    const current = h.windows[1];
    current.loading.resolve();
    assert.equal((await settled(next)).ok, true);
    old.emit('closed');
    old.webContents.emit('render-process-gone');
    old.loading.reject(new Error('obsolete fixture load failure'));
    await turn();
    t.mock.timers.tick(10001);
    assert.equal(h.notices.length, 1, 'obsolete callbacks cannot report a new failure');
    assert.equal(current.destroyed, false);
    assert.equal(current.visible, true);
  });
}

test('HTML watchdog closes loading windows on sustained overload or monitoring failure and permits retry', async (t) => {
  const faults = {};
  const h = setup(t, faults);
  const pending = h.start();
  const old = h.windows[0];
  h.metrics([{ pid: old.id, memory: { workingSetSize: 1024 }, cpu: { percentCPUUsage: 90 } }]);
  t.mock.timers.tick(1000);
  assert.equal(old.destroyed, false);
  t.mock.timers.tick(1000);
  assert.equal((await settled(pending)).ok, false);
  assert.equal(old.destroyed, true);
  assert.equal(old.showCalls, 0);
  assert.match(h.notices[0], /占用过高/);
  const monitored = h.start();
  const failed = h.windows[1];
  faults.metricsError = new Error('fixture metrics unavailable');
  t.mock.timers.tick(1000);
  assert.equal((await settled(monitored)).ok, false);
  assert.equal(failed.destroyed, true);
  assert.equal(failed.showCalls, 0);
  assert.match(h.notices[1], /无法检查/);
  delete faults.metricsError;
  h.metrics([]);
  const recovered = h.start();
  const current = h.windows[2];
  current.loading.resolve();
  assert.equal((await settled(recovered)).ok, true);
  assert.equal(current.visible, true);
});

test('HTML visibility set before show stays hidden after loading and can be restored', async (t) => {
  const h = setup(t);
  h.host.visible(false);
  const pending = h.start();
  const window = h.windows[0];
  assert.equal(window.showCalls, 0);
  window.loading.resolve();
  assert.equal((await settled(pending)).ok, true);
  assert.equal(window.visible, false);
  assert.equal(window.showCalls, 0);
  h.host.visible(true);
  assert.equal(window.visible, true);
  assert.equal(window.showCalls, 1);
});
