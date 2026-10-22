const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const source =
  process.env.TMA_CAPTURE_BASELINE === '1'
    ? execFileSync('git', ['show', 'HEAD:src/host/main.ts'], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, 'src/host/main.ts'), 'utf8');
// Compile the complete host, including its real controllers and HTTP routes. These exports
// exist only in this in-memory test bundle; application startup is never allowed to run.
const hooks = `
let captureTestHtmlClears = 0;
const captureTestClearHtml = htmlHost.clear.bind(htmlHost);
htmlHost.clear = () => { captureTestHtmlClears++; captureTestClearHtml(); };
export const captureTest = {
  startServer, captureScreen, action, snapshot,
  initialize(window: any, inputPolicy: () => Promise<void>) {
    panel = overlay = settingsWindow = window;
    settings = { ...defaults, captureTier: 'always', autoCollapseSec: 0 };
    windows.inputPolicy = inputPolicy;
    windows.activate = async () => false;
    windows.foreground = async () => null;
    observeDisplays();
  },
  endSession() { session?.end(); },
  prepareInput() { return input.prepare(false); },
  captureTier(value: Settings['captureTier']) { settings = { ...settings, captureTier: value }; },
  voiceEngine(value: Settings['voice']['engine']) { settings = { ...settings, voice: { ...settings.voice, engine: value } }; },
  state() { return { session, shots: [...shots.values()], originals: [...originals.values()], lastShot, captureState, connection, captureProtected, guides, htmlClears: captureTestHtmlClears }; }
};`;
const compiled = buildSync({
  stdin: { contents: source + hooks, resolveDir: path.join(root, 'src/host'), loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  write: false,
  logLevel: 'silent',
}).outputFiles[0].text;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label = 'lifecycle boundary') {
  for (let n = 0; n < 600; n++) {
    if (await read()) return;
    await pause(5);
  }
  throw new Error(`fixture did not reach ${label}`);
}
async function completed(promise) {
  const marker = Symbol('pending');
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(marker), 1000);
  });
  const result = await Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  assert.notEqual(result, marker, 'invalidated operation must finish promptly');
  return result;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}
async function setup(t, options = {}) {
  const files = new Map();
  const events = [];
  const removals = [];
  const writes = [];
  const directories = [];
  const timers = new Set();
  let handler;
  let endpoint;
  let acquisitions = 0;
  let windowCreations = 0;
  let entered = false;
  let boardExports = 0;
  const gate = deferred();
  const hold = async (phase) => {
    if (options.hold === phase && !entered) {
      entered = true;
      await gate.promise;
    }
  };
  const displays = (options.singleDisplay ? [1] : [1, 2]).map((id) => ({
    id,
    label: `Synthetic ${id}`,
    scaleFactor: 1,
    size: { width: 1000, height: 800 },
    bounds: { x: (id - 1) * 1000, y: 0, width: 1000, height: 800 },
    workArea: { x: (id - 1) * 1000, y: 0, width: 1000, height: 800 },
  }));
  const syntheticImage = (width, height) => ({
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(JSON.stringify({ width, height })),
    crop: (rect) => syntheticImage(rect.width, rect.height),
    resize: (size) => syntheticImage(size.width, size.height),
  });
  const pixels = syntheticImage(1000, 800);
  const fakeApp = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => 'fixture-home',
    requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch() {} },
    whenReady: () => new Promise(() => {}),
    isReady: () => false,
    exit() {
      throw new Error('unexpected application exit');
    },
  });
  const window = {
    setContentProtection() {},
    setIgnoreMouseEvents() {},
    setSkipTaskbar() {},
    setBounds() {},
    isDestroyed: () => false,
    isFocused: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8),
    webContents: {
      getZoomFactor: () => 1,
      async executeJavaScript(script) {
        assert.match(script, /^window\.companionBoard\?\.export\(\d+\)$/);
        boardExports++;
        await hold('board-export');
        return 'data:image/png;base64,c3ludGhldGlj';
      },
    },
  };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
  });
  const electron = {
    app: fakeApp,
    nativeImage: {
      createFromDataURL: () => pixels,
      createFromPath(file) {
        assert.ok(files.has(file), 'zoom reads an existing synthetic source image');
        const size = JSON.parse(String(files.get(file)));
        return syntheticImage(size.width, size.height);
      },
    },
    BrowserWindow: class {
      constructor() {
        windowCreations++;
        throw new Error('native window creation forbidden');
      }
    },
    nativeTheme: { shouldUseDarkColors: false },
    screen,
    desktopCapturer: {
      getSources: async () => {
        acquisitions++;
        if (acquisitions <= (options.failAcquisitions || 0))
          throw new Error('transient fixture capture failure');
        await hold('sources');
        return displays.map((display) => ({ display_id: String(display.id), thumbnail: pixels }));
      },
    },
  };
  const filePort = {
    mkdir: async (directory) => {
      directories.push(directory);
      if (boardExports) await hold('board-mkdir');
      await hold('mkdir');
    },
    writeFile: async (file, data) => {
      writes.push(file);
      files.set(file, data);
      if (file.endsWith('endpoint.json')) endpoint = JSON.parse(data);
      else {
        const phase = file.endsWith('-board.png')
          ? 'board'
          : file.endsWith('-original.png')
            ? 'original'
            : 'thumbnail';
        await hold(phase);
        if (options.writeError && (!options.writeErrorPhase || options.writeErrorPhase === phase))
          throw options.writeError;
      }
    },
    rm: async (file) => {
      removals.push(file);
      if (options.cleanupError) throw options.cleanupError;
      files.delete(file);
    },
  };
  const module = { exports: {} };
  const forbidden = () => {
    throw new Error('real filesystem, native process or network operation forbidden');
  };
  const fakeRequire = (name) => {
    if (name === 'electron') return electron;
    if (name === 'node:fs/promises') return filePort;
    if (name === 'node:fs')
      return {
        mkdirSync() {},
        appendFileSync(_file, line) {
          events.push(JSON.parse(line));
        },
        statSync: () => ({ size: 0 }),
        writeFileSync() {},
      };
    if (name === 'node:child_process') return { spawn: forbidden };
    if (name === 'node:http')
      return {
        createServer: (callback) => {
          handler = callback;
          return { listen: (_port, _host, ready) => ready(), address: () => ({ port: 12345 }) };
        },
      };
    if (['node:path', 'node:crypto'].includes(name)) return require(name);
    throw new Error(`unapproved fixture module: ${name}`);
  };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: fakeRequire,
    Buffer,
    URL,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    console,
    process: { env: { TMA_LAUNCH_SECRET: 'fixture-launch' }, platform: 'win32', pid: 1, on() {} },
    __dirname: path.join(root, 'src/host'),
    fetch: forbidden,
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
    setInterval: forbidden,
    clearInterval() {},
  });
  const api = module.exports.captureTest;
  api.initialize(window, () => hold('cancel'));
  t.after(() => {
    gate.resolve();
    for (const timer of timers) clearTimeout(timer);
  });
  await api.startServer();
  const request = (route, data = {}, token = api.state().session?.token) => {
    let reply;
    const result = new Promise((resolve) => (reply = resolve));
    const req = {
      url: '/' + route,
      method: 'POST',
      headers: { 'x-companion-token': endpoint.token, 'x-session-token': token },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(data));
        // Hold after the full payload arrives, before body() can resume route handling.
        if (route === 'wait') await hold('wait-body');
      },
    };
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead(status) {
        this.status = status;
      },
      end(raw) {
        this.writableEnded = true;
        reply({ status: this.status, body: JSON.parse(raw) });
      },
    });
    const done = handler(req, res);
    return {
      result,
      done,
      disconnect() {
        res.destroyed = true;
        res.emit('close');
      },
    };
  };
  if (!options.noSession) {
    const initial = await request('start', {
      launchSecret: 'fixture-launch',
      ...(options.implicitDisplay ? {} : { displayId: 1 }),
    }).result;
    assert.equal(initial.status, 200, 'initial real start route succeeds');
  }
  const replace = async () => {
    api.endSession();
    const pending = request('start', { topic: 'replacement fixture', displayId: 1 });
    await until(() => !!api.state().connection, 'replacement approval');
    await api.action({ type: 'connection-decision', allow: true });
    assert.equal((await pending.result).status, 200);
  };
  return {
    api,
    request,
    replace,
    displays,
    removeDisplay(id) {
      const index = displays.findIndex((display) => display.id === id);
      assert.notEqual(index, -1, 'removed synthetic display exists');
      const [display] = displays.splice(index, 1);
      screen.emit('display-removed', {}, display);
    },
    files,
    events,
    removals,
    writes,
    directories,
    entered: () => entered,
    release: gate.resolve,
    acquisitions: () => acquisitions,
    windowCreations: () => windowCreations,
    pngFiles: () => [...files.keys()].filter((file) => file.endsWith('.png')),
  };
}
function noPublishedShots(h) {
  const state = h.api.state();
  assert.equal(state.shots.length, 0);
  assert.equal(state.originals.length, 0);
  assert.equal(state.lastShot, null);
  assert.equal(state.captureProtected, false, 'capture visibility protection is released');
  assert.equal(h.pngFiles().length, 0, 'invalidated temporary screenshot files are removed');
}

async function prepareBoardInput(h) {
  const turnId = await h.api.prepareInput();
  await h.api.action({ type: 'board-change', epoch: h.api.snapshot().userBoard.epoch, count: 1 });
  return turnId;
}
const boardFiles = (h) => h.pngFiles().filter((file) => file.endsWith('-board.png'));
const submitBoard = (h, turnId) =>
  h.api.action({ type: 'submit', turnId, text: 'board attachment fixture', attachBoard: true });

test('board attachment canceled during export never creates files and the next submission succeeds', async (t) => {
  const h = await setup(t, { hold: 'board-export' });
  const turnId = await prepareBoardInput(h);
  const originals = h.pngFiles();
  const directoryCount = h.directories.length;
  const failed = assert.rejects(submitBoard(h, turnId), /取消|作废/);
  await until(h.entered, 'board export');
  await h.api.action({ type: 'cancel' });
  h.release();
  await completed(failed);
  assert.equal(h.directories.length, directoryCount, 'canceled export must not reach mkdir');
  assert.deepEqual(h.pngFiles(), originals);
  assert.equal(h.api.state().session.messages.length, 0);

  const next = await prepareBoardInput(h);
  await submitBoard(h, next);
  const messages = h.api.state().session.messages;
  assert.equal(messages.length, 1);
  assert.equal(boardFiles(h).length, 1);
  assert.ok(messages[0].shots.some((shot) => shot.path === boardFiles(h)[0]));
  assert.ok(originals.every((file) => h.files.has(file)));
});

test('board attachment canceled during mkdir never starts a file write', async (t) => {
  const h = await setup(t, { hold: 'board-mkdir' });
  const turnId = await prepareBoardInput(h);
  const originals = h.pngFiles();
  const failed = assert.rejects(submitBoard(h, turnId), /取消|作废/);
  await until(h.entered, 'board mkdir');
  await h.api.action({ type: 'cancel' });
  h.release();
  await completed(failed);
  assert.equal(h.writes.filter((file) => file.endsWith('-board.png')).length, 0);
  assert.deepEqual(h.pngFiles(), originals);
  assert.equal(h.api.state().session.messages.length, 0);
});

for (const invalidation of ['cancel', 'end', 'clear']) {
  test(`board attachment ${invalidation} during write removes only the uncommitted attachment`, async (t) => {
    const h = await setup(t, { hold: 'board' });
    const turnId = await prepareBoardInput(h);
    const originals = h.pngFiles();
    const failed = assert.rejects(submitBoard(h, turnId), /取消|作废|变更|结束/);
    await until(h.entered, 'board write');
    const output = boardFiles(h)[0];
    assert.ok(output, 'write has created a partial board attachment');
    if (invalidation === 'end') h.api.endSession();
    else
      await h.api.action({
        type: invalidation,
        ...(invalidation === 'clear' ? { layer: 'user' } : {}),
      });
    h.release();
    await completed(failed);
    assert.deepEqual(h.pngFiles(), originals);
    assert.deepEqual(h.removals, [output]);
    assert.equal(h.api.state().session.messages.length, 0);
  });
}

test('board attachment partial write failure preserves earlier committed attachments and source frames', async (t) => {
  const options = { writeErrorPhase: 'board' };
  const h = await setup(t, options);
  await submitBoard(h, await prepareBoardInput(h));
  const committed = boardFiles(h)[0];
  assert.ok(committed);
  const turnId = await prepareBoardInput(h);
  const retained = h.pngFiles();
  const writeError = Object.assign(new Error('private board write failure'), { code: 'ENOSPC' });
  options.writeError = writeError;
  await assert.rejects(submitBoard(h, turnId), (error) => error === writeError);
  assert.deepEqual(h.pngFiles(), retained);
  assert.equal(h.removals.length, 1);
  assert.notEqual(h.removals[0], committed);
  assert.ok(h.removals[0].endsWith('-board.png'));
  assert.equal(h.api.state().session.messages.length, 1);
  assert.equal(h.api.snapshot().input.phase, 'editing', 'failed submission remains retryable');
  options.writeError = undefined;
  await submitBoard(h, turnId);
  assert.equal(h.api.state().session.messages.length, 2);
  assert.equal(boardFiles(h).length, 2);
  assert.ok(retained.every((file) => h.files.has(file)));
  assert.equal(h.api.snapshot().input.phase, 'idle');
});

test('board attachment cleanup failure retains the write error and reports safe metadata', async (t) => {
  const writeError = Object.assign(new Error('PRIVATE_BOARD_WRITE_CONTENT'), { code: 'ENOSPC' });
  const cleanupError = Object.assign(new Error('PRIVATE_BOARD_CLEANUP_PATH'), { code: 'EPERM' });
  const h = await setup(t, { writeError, writeErrorPhase: 'board', cleanupError });
  const turnId = await prepareBoardInput(h);
  const originals = h.pngFiles();
  await assert.rejects(submitBoard(h, turnId), (error) => error === writeError);
  assert.equal(h.removals.length, 1);
  assert.ok(h.removals[0].endsWith('-board.png'));
  assert.ok(originals.every((file) => h.files.has(file)));
  assert.equal(h.api.state().session.messages.length, 0);
  const failures = h.events.filter((event) => event.event === 'board-attachment-cleanup-failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'EPERM');
  assert.doesNotMatch(JSON.stringify(failures), /PRIVATE_|fixture-home|sessions|board\.png/);
});

test('wait disconnected while completing its body releases the route and permits delivery on reconnect', async (t) => {
  const h = await setup(t, { hold: 'wait-body' });
  const session = h.api.state().session;
  t.after(() => session.end());
  const old = h.request('wait', { timeoutMs: 480000 });
  await until(h.entered, 'complete wait body before route continuation');
  old.disconnect();
  h.release();
  await completed(old.done);
  assert.equal(session.phase, 'ready', 'disconnected request must not enter waiting state');

  const next = h.request('wait', { timeoutMs: 480000 });
  await until(() => session.phase === 'waiting', 'reconnected consumer');
  const message = session.push('message after reconnect', [], 'wait-reconnect');
  const response = await completed(next.result);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.messages.map((item) => item.id),
    [message.id],
  );
  assert.equal((await h.request('ack', { id: message.id }).result).status, 200);
  assert.equal(session.pending.length, 0);
});

test('wait disconnected while completing its body cannot mark queued messages delivered', async (t) => {
  const h = await setup(t, { hold: 'wait-body' });
  const session = h.api.state().session;
  t.after(() => session.end());
  const message = session.push('still needs delivery', [], 'wait-pending');
  const old = h.request('wait', { timeoutMs: 480000 });
  await until(h.entered, 'complete wait body before route continuation');
  old.disconnect();
  h.release();
  await completed(old.done);
  const premature = await h.request('ack', { id: message.id }).result;
  assert.equal(premature.status, 400);
  assert.match(premature.body.error, /不能确认尚未交付的消息/);
  assert.equal(session.pending.length, 1);

  const response = await completed(h.request('wait', { timeoutMs: 480000 }).result);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.messages.map((item) => item.id),
    [message.id],
  );
  assert.equal((await h.request('ack', { id: message.id }).result).status, 200);
  assert.equal(session.pending.length, 0);
});

test('registered wait disconnect releases only its own consumer and preserves single-consumer delivery', async (t) => {
  const h = await setup(t);
  const session = h.api.state().session;
  t.after(() => session.end());
  const old = h.request('wait', { timeoutMs: 480000 });
  await until(() => session.phase === 'waiting', 'initial registered consumer');
  old.disconnect();
  await completed(old.done);
  assert.equal(session.phase, 'ready');

  const next = h.request('wait', { timeoutMs: 480000 });
  await until(() => session.phase === 'waiting', 'replacement registered consumer');
  old.disconnect();
  const duplicate = await completed(h.request('wait', { timeoutMs: 480000 }).result);
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.body.error, /已有 wait 正在等待/);
  const message = session.push('only the current consumer receives this', [], 'wait-current');
  const response = await completed(next.result);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.messages.map((item) => item.id),
    [message.id],
  );
  assert.equal((await h.request('ack', { id: message.id }).result).status, 200);
  assert.equal(session.pending.length, 0);
});

test('old session capture cannot retry into or disclose a replacement session', async (t) => {
  const h = await setup(t, { hold: 'sources' });
  const pending = h.request('capture');
  await until(h.entered);
  await h.replace();
  h.release();
  const result = await pending.result;
  assert.notEqual(result.status, 200, 'old credentials must not receive replacement screenshot');
  assert.equal(result.body.shot, undefined);
  assert.equal(h.acquisitions(), 1, 'session change is not a transient capture error');
  noPublishedShots(h);
});

for (const phase of ['mkdir', 'thumbnail', 'original']) {
  test(`session replacement during ${phase} cannot publish old screenshots`, async (t) => {
    const h = await setup(t, { hold: phase });
    const pending = h.request('capture');
    await until(h.entered);
    await h.replace();
    h.release();
    assert.notEqual((await pending.result).status, 200);
    assert.equal(h.acquisitions(), 1);
    noPublishedShots(h);
  });
}

test('teaching display change invalidates an in-flight capture without retry', async (t) => {
  const h = await setup(t, { hold: 'sources' });
  const pending = h.request('capture');
  await until(h.entered);
  await h.api.action({ type: 'select-display', id: 2 });
  h.release();
  assert.notEqual((await pending.result).status, 200);
  assert.equal(h.acquisitions(), 1);
  noPublishedShots(h);
});

test('same-display geometry change during file writing invalidates the capture', async (t) => {
  const h = await setup(t, { hold: 'original' });
  const pending = h.request('capture');
  await until(h.entered);
  h.displays[0].bounds = { ...h.displays[0].bounds, width: 900 };
  h.release();
  assert.notEqual((await pending.result).status, 200);
  noPublishedShots(h);
});

test('queued captures invalidated by session change do not acquire another frame', async (t) => {
  const h = await setup(t, { hold: 'sources' });
  const old = h.api.captureScreen().then(
    () => false,
    () => true,
  );
  await until(h.entered);
  const queued = h.api.captureScreen().then(
    () => false,
    () => true,
  );
  await h.replace();
  h.release();
  assert.equal(await old, true);
  assert.equal(await queued, true);
  assert.equal(h.acquisitions(), 1);
  noPublishedShots(h);
});

test('capture still retries transient acquisition errors and publishes its own session frame', async (t) => {
  const h = await setup(t, { failAcquisitions: 1 });
  const expectedSession = h.api.state().session.id;
  const result = await h.request('capture').result;
  assert.equal(result.status, 200);
  assert.equal(h.acquisitions(), 2);
  assert.ok(result.body.shot.path.includes(expectedSession));
  assert.equal(h.api.state().shots.length, 1);
  assert.equal(h.pngFiles().length, 2);
});

test('persistent acquisition failure stops after the existing three-attempt limit', async (t) => {
  const h = await setup(t, { failAcquisitions: 10 });
  const result = await h.request('capture').result;
  assert.notEqual(result.status, 200);
  assert.equal(h.acquisitions(), 3);
  noPublishedShots(h);
});

test('disconnect withdraws only its pending capture approval and never captures', async (t) => {
  const h = await setup(t);
  h.api.captureTier('ask');
  const old = h.request('capture');
  await until(() => !!h.api.state().captureState, 'capture approval');
  old.disconnect();
  await completed(old.done);
  assert.equal(h.api.state().captureState, null);
  assert.equal(h.acquisitions(), 0);
  const current = h.request('capture');
  await until(() => !!h.api.state().captureState, 'fresh capture approval');
  old.disconnect();
  assert.ok(h.api.state().captureState);
  await h.api.action({ type: 'capture-decision', decision: 'allow' });
  assert.equal((await current.result).status, 200);
  assert.equal(h.acquisitions(), 1);
});

for (const phase of ['sources', 'thumbnail', 'original']) {
  test(`disconnect during ${phase} cannot register a screenshot or leave files`, async (t) => {
    const h = await setup(t, { hold: phase });
    const pending = h.request('capture');
    await until(h.entered);
    pending.disconnect();
    h.release();
    await completed(pending.done);
    assert.equal(h.acquisitions(), 1, 'disconnected requests never retry');
    noPublishedShots(h);
  });
}

test('capture consent cannot authorize a different teaching display', async (t) => {
  const h = await setup(t);
  h.api.captureTier('ask');
  const pending = h.request('capture');
  await until(() => !!h.api.state().captureState, 'capture approval');
  await h.api.action({ type: 'select-display', id: 2 });
  await h.api.action({ type: 'capture-decision', decision: 'allow' });
  assert.notEqual((await pending.result).status, 200);
  assert.equal(h.acquisitions(), 0, 'stale consent must be rejected before acquisition');
  noPublishedShots(h);
});

test('partial write cleanup failure keeps the write error and reports only safe metadata', async (t) => {
  const writeError = Object.assign(new Error('private screenshot write failure'), {
    code: 'ENOSPC',
  });
  const cleanupError = Object.assign(new Error('private screenshot cleanup failure'), {
    code: 'EPERM',
  });
  const h = await setup(t, { writeError, cleanupError });
  await assert.rejects(h.api.captureScreen(), (error) => error === writeError);
  assert.equal(h.removals.length, 2, 'both possible screenshot files get a cleanup attempt');
  assert.equal(new Set(h.removals).size, 2);
  assert.equal(h.api.state().shots.length, 0);
  assert.equal(h.api.state().originals.length, 0);
  assert.equal(h.api.state().captureProtected, false);
  const failures = h.events.filter((event) => event.event === 'capture-cleanup-failed');
  assert.equal(failures.length, 2);
  assert.ok(failures.every((event) => event.code === 'EPERM'));
  assert.doesNotMatch(JSON.stringify(failures), /private screenshot/);
  assert.equal(
    h.pngFiles().length,
    1,
    'a failed deletion is not represented as successful cleanup',
  );
});

async function captureZoomSource(h) {
  const result = await h.request('capture').result;
  assert.equal(result.status, 200);
  return { shot: result.body.shot, files: h.pngFiles().sort() };
}

function sourceFilesPreserved(h, source) {
  assert.deepEqual(h.pngFiles().sort(), source.files, 'only this failed zoom output is removed');
  assert.ok(
    h.removals.every((file) => !source.files.includes(file)),
    'source pixels remain intact',
  );
}

for (const phase of ['thumbnail', 'original']) {
  test(`zoom session replacement during ${phase} cannot populate the new session`, async (t) => {
    const options = {};
    const h = await setup(t, options);
    const source = await captureZoomSource(h);
    options.hold = phase;
    const pending = h.request('zoom', { shot: source.shot.id, rect: [100, 80, 400, 300] });
    await until(h.entered);
    await h.replace();
    h.release();
    const result = await pending.result;
    assert.notEqual(result.status, 200, 'old request cannot publish after its session changes');
    assert.equal(result.body.shot, undefined);
    assert.equal(h.api.state().shots.length, 0);
    assert.equal(h.api.state().originals.length, 0);
    assert.equal(h.api.state().lastShot, null);
    sourceFilesPreserved(h, source);
  });

  test(`zoom disconnect during ${phase} cannot register a result or leave output`, async (t) => {
    const options = {};
    const h = await setup(t, options);
    const source = await captureZoomSource(h);
    options.hold = phase;
    const pending = h.request('zoom', { shot: source.shot.id, rect: [100, 80, 400, 300] });
    await until(h.entered);
    pending.disconnect();
    h.release();
    await completed(pending.done);
    assert.equal(h.api.state().shots.length, 1);
    assert.equal(h.api.state().originals.length, 1);
    assert.equal(h.api.state().lastShot.id, source.shot.id);
    sourceFilesPreserved(h, source);
  });

  test(`zoom partial ${phase} write failure removes only its outputs`, async (t) => {
    const options = {};
    const h = await setup(t, options);
    const source = await captureZoomSource(h);
    options.writeError = new Error('fixture zoom disk full');
    options.writeErrorPhase = phase;
    const result = await h.request('zoom', { shot: source.shot.id, rect: [100, 80, 400, 300] })
      .result;
    assert.equal(result.status, 400);
    assert.match(result.body.error, /^(Error: )?fixture zoom disk full$/);
    assert.equal(h.api.state().shots.length, 1);
    assert.equal(h.api.state().lastShot.id, source.shot.id);
    sourceFilesPreserved(h, source);
  });
}

test('zoom preserves nested crop geometry and permits historical frames without stale show', async (t) => {
  const h = await setup(t);
  const source = await captureZoomSource(h);
  const first = await h.request('zoom', { shot: source.shot.id, rect: [100, 80, 400, 300] }).result;
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.shot.width, first.body.shot.height], [400, 300]);
  assert.deepEqual(first.body.shot.crop, { x: 100, y: 80, width: 400, height: 300 });
  await h.api.action({ type: 'select-display', id: 2 });
  const nested = await h.request('zoom', { shot: first.body.shot.id, rect: [50, 30, 100, 120] })
    .result;
  assert.equal(nested.status, 200, 'zoom transforms an existing frame, not the current screen');
  assert.equal(nested.body.shot.displayId, 1);
  assert.deepEqual([nested.body.shot.width, nested.body.shot.height], [100, 120]);
  assert.deepEqual(nested.body.shot.crop, { x: 150, y: 110, width: 100, height: 120 });
  assert.equal(h.acquisitions(), 1, 'zoom never captures another frame');
  assert.equal(h.pngFiles().length, 6);
  const show = await h.request('show', { shot: nested.body.shot.id, say: 'fixture', items: [] })
    .result;
  assert.equal(show.status, 400);
  assert.match(show.body.error, /屏幕布局已改变/);
});

test('zoom cleanup failure preserves the original write error and source files', async (t) => {
  const options = {};
  const h = await setup(t, options);
  const source = await captureZoomSource(h);
  options.writeError = Object.assign(new Error('private zoom write failure'), { code: 'ENOSPC' });
  options.cleanupError = Object.assign(new Error('private zoom cleanup failure'), {
    code: 'EPERM',
  });
  const result = await h.request('zoom', { shot: source.shot.id, rect: [100, 80, 400, 300] })
    .result;
  assert.equal(result.status, 400);
  assert.match(result.body.error, /^(Error: )?private zoom write failure$/);
  assert.equal(h.api.state().shots.length, 1);
  assert.equal(h.api.state().lastShot.id, source.shot.id);
  assert.equal(h.removals.length, 2, 'both possible zoom outputs get a cleanup attempt');
  assert.equal(new Set(h.removals).size, 2);
  assert.ok(h.removals.every((file) => !source.files.includes(file)));
  assert.ok(source.files.every((file) => h.files.has(file)));
  const failures = h.events.filter((event) => event.code === 'EPERM');
  assert.equal(failures.length, 2);
  assert.doesNotMatch(JSON.stringify(failures), /private zoom/);
  assert.equal(h.pngFiles().length, 3, 'failed deletion is not reported as successful cleanup');
});

const htmlItem = (rect, html = '<p>fixture</p>') => ({ type: 'html', rect, html });
test('display removal requires explicit reselection before capture or stale primary-screen show', async (t) => {
  const h = await setup(t);
  const source = await captureZoomSource(h);
  await h.api.action({ type: 'select-display', id: 2 });
  h.removeDisplay(2);
  const state = h.api.snapshot();
  assert.equal(state.displayId, null);
  assert.equal(state.selectingDisplay, true);
  const status = await h.request('status').result;
  assert.equal(status.status, 200);
  assert.equal(status.body.displayId, null);
  const before = h.acquisitions();
  assert.equal((await h.request('capture').result).status, 400);
  assert.equal(h.acquisitions(), before, 'missing selection must not capture the fallback primary');
  const show = await h.request('show', {
    shot: source.shot.id,
    say: 'must not reuse the fallback screen',
    items: [{ type: 'arrow', to: [150, 120] }],
  }).result;
  assert.equal(show.status, 400);
  assert.equal(h.api.state().guides.length, 0);
  await h.api.action({ type: 'select-display', id: 1 });
  assert.equal(h.api.snapshot().displayId, 1);
  assert.equal(h.api.snapshot().selectingDisplay, false);
  const restored = await h.request('capture').result;
  assert.equal(restored.status, 200);
  assert.equal(restored.body.shot.displayId, 1);
  assert.equal(h.acquisitions(), before + 1);
});

test('display removal of an unrelated screen preserves the selected teaching display', async (t) => {
  const h = await setup(t);
  await h.api.action({ type: 'select-display', id: 2 });
  h.removeDisplay(1);
  assert.equal(h.api.snapshot().displayId, 2);
  assert.equal(h.api.snapshot().selectingDisplay, false);
  const result = await h.request('capture').result;
  assert.equal(result.status, 200);
  assert.equal(result.body.shot.displayId, 2);
});

test('display removal after implicit single-screen start cannot silently change the teaching screen', async (t) => {
  const h = await setup(t, { singleDisplay: true, implicitDisplay: true });
  assert.equal(h.api.snapshot().displayId, 1);
  h.displays.push({
    ...h.displays[0],
    id: 2,
    label: 'Synthetic replacement',
    bounds: { ...h.displays[0].bounds, x: 1000 },
    workArea: { ...h.displays[0].workArea, x: 1000 },
  });
  h.removeDisplay(1);
  assert.equal(h.api.snapshot().displayId, null);
  assert.equal(h.api.snapshot().selectingDisplay, true);
  assert.equal((await h.request('capture').result).status, 400);
  assert.equal(h.acquisitions(), 0);
});

test('display status without an active session still reports the default primary screen', async (t) => {
  const h = await setup(t, { noSession: true });
  const result = await h.request('status').result;
  assert.equal(result.status, 200);
  assert.equal(result.body.displayId, 1);
  assert.equal(h.api.snapshot().displayId, 1);
  assert.equal(h.api.snapshot().selectingDisplay, false);
});

test('display selection cannot commit a target removed while canceling the previous input', async (t) => {
  const options = {};
  const h = await setup(t, options);
  options.hold = 'cancel';
  const pending = h.api.action({ type: 'select-display', id: 2 }).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  await until(h.entered);
  h.removeDisplay(2);
  h.release();
  assert.equal(
    (await pending).ok,
    false,
    'selection must revalidate its target after cancellation',
  );
  assert.equal(h.api.snapshot().displayId, 1);
  assert.equal(h.api.snapshot().selectingDisplay, false);
});

test('display removal during approved start cleanup cannot create a session and a retry recovers', async (t) => {
  const h = await setup(t, { noSession: true, hold: 'cancel' });
  const pending = h.request('start', {
    topic: 'approved start with a disappearing screen',
    displayId: 2,
  });
  await until(() => !!h.api.state().connection, 'initial connection approval');
  await h.api.action({ type: 'connection-decision', allow: true });
  await until(h.entered, 'approved start waiting for input cancellation');
  h.removeDisplay(2);
  h.release();
  const failed = await pending.result;
  assert.equal(failed.status, 400);
  assert.equal(failed.body.token, undefined);
  assert.equal(failed.body.id, undefined);
  assert.equal(h.api.state().session, null, 'invalidated start must not create an orphan session');

  const next = h.request('start', { topic: 'recovered teaching', displayId: 1 });
  await until(() => !!h.api.state().connection, 'retry connection approval');
  await h.api.action({ type: 'connection-decision', allow: true });
  const recovered = await next.result;
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.token, h.api.state().session.token);
  assert.equal(h.api.snapshot().displayId, 1);
  assert.equal(h.api.snapshot().selectingDisplay, false);
});

test('display removal withdraws pending capture approval and blocks another capture', async (t) => {
  const h = await setup(t);
  await h.api.action({ type: 'select-display', id: 2 });
  h.api.captureTier('ask');
  const pending = h.request('capture');
  await until(() => !!h.api.state().captureState, 'capture approval before disconnection');
  h.removeDisplay(2);
  await completed(pending.done);
  assert.equal((await pending.result).status, 400);
  assert.equal(h.api.state().captureState, null);
  assert.equal(h.acquisitions(), 0);
  const next = h.request('capture');
  await completed(next.done);
  assert.equal((await next.result).status, 400);
  assert.equal(h.api.state().captureState, null);
  assert.equal(h.acquisitions(), 0);
});

test('display removal cancels an active voice controller without starting a microphone', async (t) => {
  const h = await setup(t);
  await h.api.action({ type: 'select-display', id: 2 });
  // The renderer is never loaded; custom recording here is controller state only.
  h.api.voiceEngine('custom');
  await h.api.action({ type: 'voice-start' });
  assert.equal(h.api.snapshot().voice.phase, 'recording');
  h.removeDisplay(2);
  await pause(0);
  assert.equal(h.api.snapshot().voice.phase, 'idle');
  assert.equal(h.api.snapshot().voice.id, null);
  assert.equal(h.api.snapshot().input.phase, 'idle');
});

for (const invalid of [
  {
    name: 'HTML containing an unpaired surrogate',
    items: [htmlItem([0, 0, 200, 100], '\ud800')],
    error: /无效 Unicode/,
  },
  {
    name: 'multiple HTML items',
    items: [htmlItem([0, 0, 200, 100]), htmlItem([200, 0, 200, 100])],
    error: /最多一段 HTML/,
  },
  {
    name: 'HTML exceeding the display coverage limit',
    items: [htmlItem([0, 0, 900, 600])],
    error: /最多覆盖 35%/,
  },
  {
    name: 'HTML outside the display',
    items: [htmlItem([950, 0, 200, 100])],
    error: /位于屏内/,
  },
  {
    name: 'HTML exceeding the UTF-8 byte limit',
    items: [htmlItem([0, 0, 200, 100], '中'.repeat(90000))],
    error: /HTML 超过 256KB/,
  },
]) {
  test(`invalid show with ${invalid.name} preserves the existing scene atomically`, async (t) => {
    const h = await setup(t);
    const source = await captureZoomSource(h);
    const first = await h.request('show', {
      shot: source.shot.id,
      say: 'original teaching message',
      items: [{ type: 'arrow', to: [150, 120] }],
    }).result;
    assert.equal(first.status, 200);
    const observed = () => ({
      guides: JSON.stringify(h.api.state().guides),
      messages: JSON.stringify(h.api.state().session.messages),
      htmlClears: h.api.state().htmlClears,
      windowCreations: h.windowCreations(),
    });
    const before = observed();
    const failed = await h.request('show', {
      shot: source.shot.id,
      say: 'rejected teaching message',
      items: invalid.items,
    }).result;
    assert.equal(failed.status, 400);
    assert.deepEqual(
      observed(),
      before,
      'invalid scene must not mutate guides, messages or windows',
    );
    assert.match(failed.body.error, invalid.error);
    const recovered = await h.request('show', {
      shot: source.shot.id,
      say: 'next valid teaching message',
      items: [{ type: 'arrow', to: [250, 220] }],
    }).result;
    assert.equal(recovered.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.state().guides)), [
      { type: 'arrow', to: [250, 220] },
    ]);
    assert.deepEqual(
      h.api
        .state()
        .session.messages.map((message) => message.text)
        .join('|'),
      'original teaching message|next valid teaching message',
    );
    assert.equal(h.windowCreations(), 0);
  });
}
