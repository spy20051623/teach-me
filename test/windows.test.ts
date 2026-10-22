import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { WindowsAdapter } from '../src/host/windows.ts';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: { id: number; kind: string }[] = [];
  writeFailure: Error | null = null;
  kills = 0;
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      if (this.writeFailure) throw this.writeFailure;
      this.requests.push(JSON.parse(line));
      return true;
    },
  });
  kill() {
    // Real child termination is asynchronous; the test controls the eventual exit.
    this.kills++;
    return true;
  }
  reply(value: string) {
    const request = this.requests.at(-1)!;
    this.stdout.emit('data', `@${request.id}=${value}\n`);
  }
}

function setup(
  t: TestContext,
  options: {
    spawnFailure?: Error;
    configure?: (child: FakeChild) => void;
    reportThrows?: boolean;
  } = {},
) {
  const children: FakeChild[] = [];
  const reports: { event: string; detail: Record<string, string | number | boolean> }[] = [];
  t.mock.method(childProcess, 'spawn', () => {
    if (options.spawnFailure) throw options.spawnFailure;
    const child = new FakeChild();
    options.configure?.(child);
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const adapter = new WindowsAdapter((event, detail) => {
    reports.push({ event, detail });
    if (options.reportThrows) throw new Error('diagnostic sink unavailable');
  });
  t.after(() => {
    adapter.dispose();
    for (const child of children) child.emit('exit', 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { adapter, children, reports };
}

async function settledByNextTurn(promise: Promise<string | null>) {
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise<{ unresolved: true }>((resolve) =>
      setImmediate(() => resolve({ unresolved: true })),
    ),
  ]);
}

test('an old helper exit cannot end a request sent to its replacement', async (t) => {
  const { adapter, children } = setup(t);
  const first = adapter.foreground();
  const old = children[0];
  adapter.dispose();
  const second = adapter.foreground();
  const current = children[1];
  old.emit('exit', 0, null);
  current.reply('5678');
  assert.equal(await first, null);
  assert.equal(await second, '5678');
  const third = adapter.foreground();
  assert.equal(children.length, 2, 'the healthy replacement is reused');
  current.reply('9012');
  assert.equal(await third, '9012');
});

test('an incomplete old helper line cannot consume the replacement response', async (t) => {
  const { adapter, children } = setup(t);
  const first = adapter.foreground();
  const old = children[0];
  old.stdout.emit('data', `@${old.requests[0].id}=12`);
  old.emit('exit', 0, null);
  assert.equal(await first, null);
  const second = adapter.foreground();
  children[1].reply('5678');
  assert.deepEqual(await settledByNextTurn(second), { value: '5678' });
});

test('dispose ends pending requests without waiting for the helper exit event', async (t) => {
  const { adapter } = setup(t);
  const pending = adapter.foreground();
  adapter.dispose();
  assert.deepEqual(await settledByNextTurn(pending), { value: null });
});

for (const kind of ['spawn-event', 'spawn-throw', 'exit', 'write-event', 'write-throw'] as const) {
  test(`${kind} returns a specific failure code and permits a fresh helper`, async (t) => {
    const options: Parameters<typeof setup>[1] = {
      spawnFailure: kind === 'spawn-throw' ? new Error('PRIVATE_SPAWN_FAILURE') : undefined,
      configure: (child) => {
        if (kind === 'write-throw') child.writeFailure = new Error('PRIVATE_WRITE_FAILURE');
      },
    };
    const { adapter, children, reports } = setup(t, options);
    const code = kind.startsWith('spawn')
      ? 'NATIVE_SPAWN_FAILED'
      : kind.startsWith('write')
        ? 'NATIVE_WRITE_FAILED'
        : 'NATIVE_HELPER_EXIT';
    const failed = assert.rejects(adapter.inputPolicy('1234567', true, false), { code });
    if (kind === 'spawn-event') children[0].emit('error', new Error('PRIVATE_SPAWN_FAILURE'));
    if (kind === 'exit') children[0].emit('exit', 19, null);
    if (kind === 'write-event') children[0].stdin.emit('error', new Error('PRIVATE_WRITE_FAILURE'));
    await failed;
    options.spawnFailure = undefined;
    options.configure = undefined;
    const next = adapter.windowStyle('1234567');
    children.at(-1)!.reply('524288');
    assert.equal(await next, 524288);
    assert.equal(children.length, kind === 'spawn-throw' ? 1 : 2);
    assert.ok(reports.some((entry) => entry.event === 'native-request-failed'));
    assert.ok(!JSON.stringify(reports).includes('PRIVATE_'));
    assert.ok(!JSON.stringify(reports).includes('1234567'));
    if (kind === 'exit') assert.ok(reports.some((entry) => entry.detail.exitCode === 19));
  });
}

test('native False is distinct from malformed responses and a request exception', async (t) => {
  const { adapter, children } = setup(t);
  const rejected = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_POLICY_REJECTED',
  });
  children[0].reply('False');
  await rejected;
  const malformed = assert.rejects(adapter.windowStyle('123'), {
    code: 'NATIVE_PROTOCOL_ERROR',
  });
  children[0].reply('PRIVATE_INVALID_STYLE');
  await malformed;
  const exception = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_PROTOCOL_ERROR',
  });
  children[0].reply('!ERROR');
  await exception;
  const success = adapter.inputPolicy('123', true, false);
  children[0].reply('True');
  await success;
});

test('timed-out helper is retired and its late events cannot affect the replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children, reports } = setup(t);
  const failed = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_TIMEOUT',
  });
  const old = children[0];
  old.stdout.emit('data', '@READY\n');
  t.mock.timers.tick(10000);
  await failed;
  assert.equal(old.kills, 1);
  assert.ok(
    reports.some(
      (entry) =>
        entry.event === 'native-request-failed' &&
        entry.detail.kind === 'input' &&
        entry.detail.reason === 'timeout' &&
        entry.detail.ready === true &&
        entry.detail.elapsedMs === 10000,
    ),
  );
  const next = adapter.windowStyle('123');
  assert.equal(children.length, 2);
  old.reply('True');
  old.stdout.emit('data', '@READY\n@999=');
  old.emit('exit', 1, null);
  old.stdin.emit('error', new Error('late old pipe error'));
  children[1].reply('524288');
  assert.equal(await next, 524288);
  const foreground = adapter.foreground();
  assert.equal(children.length, 2, 'healthy replacement remains reusable');
  children[1].reply('5678');
  assert.equal(await foreground, '5678');
});

test('startup timeout reports not-ready and stderr byte count without raw data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children, reports } = setup(t);
  const failed = assert.rejects(adapter.windowStyle('1234567'), { code: 'NATIVE_TIMEOUT' });
  const stderr = Buffer.from('PRIVATE_COMMAND_AND_HANDLE_1234567\n故障');
  children[0].stderr.emit('data', stderr);
  t.mock.timers.tick(10000);
  await failed;
  assert.ok(
    reports.some(
      (entry) =>
        entry.event === 'native-helper-ended' &&
        entry.detail.reason === 'timeout' &&
        entry.detail.ready === false &&
        entry.detail.stderrBytes === stderr.length,
    ),
  );
  assert.ok(!JSON.stringify(reports).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(reports).includes('1234567'));
  assert.ok(!JSON.stringify(reports).includes('故障'));
});

test('diagnostic callback failures do not alter a request or disposal', async (t) => {
  const { adapter, children } = setup(t, { reportThrows: true });
  const pending = adapter.inputPolicy('123', true, false);
  children[0].stdout.emit('data', '@READY\n');
  children[0].reply('True');
  await pending;
  const foreground = adapter.foreground();
  assert.doesNotThrow(() => adapter.dispose());
  assert.equal(await foreground, null);
});

for (const ready of [false, true]) {
  test(`short query timeout preserves a ten-second window operation (ready=${ready})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { adapter, children, reports } = setup(t);
    let operationSettled = false;
    const operation = adapter.inputPolicy('123', true, false).then(
      () => {
        operationSettled = true;
        return 'success';
      },
      (error: Error & { code: string }) => {
        operationSettled = true;
        return error.code;
      },
    );
    const child = children[0];
    const input = child.requests[0];
    if (ready) child.stdout.emit('data', '@READY\n');
    const foreground = adapter.foreground();
    const down = adapter.talkDown();
    t.mock.timers.tick(3000);
    assert.equal(await foreground, null);
    assert.equal(await down, false);
    assert.equal(operationSettled, false, 'the window operation still has seven seconds');
    assert.equal(child.kills, 0);
    t.mock.timers.tick(1000);
    child.stdout.emit('data', `@${input.id}=True\n`);
    assert.equal(await operation, 'success');
    assert.equal(child.kills, 1, 'retire only after the outstanding operation completes');
    assert.ok(
      !reports.some((entry) => entry.detail.kind === 'input' && entry.detail.reason === 'timeout'),
    );
  });
}

test('polling during recovery cannot extend deadlines, send new writes or spawn competing helpers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children, reports } = setup(t);
  const style = assert.rejects(adapter.windowStyle('123'), { code: 'NATIVE_TIMEOUT' });
  const query = adapter.foreground();
  const old = children[0];
  t.mock.timers.tick(3000);
  assert.equal(await query, null);
  for (let i = 0; i < 6; i++) {
    assert.equal(await adapter.foreground(), null);
    assert.equal(await adapter.talkDown(), false);
    await assert.rejects(adapter.inputPolicy('123', true, false), {
      code: 'NATIVE_HELPER_RECOVERING',
    });
    t.mock.timers.tick(1000);
    assert.equal(old.kills, 0);
  }
  assert.equal(old.requests.length, 2, 'recovery requests never reach the old pipe');
  assert.equal(children.length, 1, 'no new helper can race the outstanding old operation');
  t.mock.timers.tick(1000);
  await style;
  assert.equal(old.kills, 1);
  assert.ok(reports.some((entry) => entry.detail.reason === 'recovering'));
  const next = adapter.windowStyle('123');
  assert.equal(children.length, 2);
  old.reply('999');
  old.emit('exit', 1);
  children[1].reply('524288');
  assert.equal(await next, 524288);
});

test('a style read timeout does not shorten a later window write deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const style = assert.rejects(adapter.windowStyle('123'), { code: 'NATIVE_TIMEOUT' });
  t.mock.timers.tick(1000);
  const input = adapter.inputPolicy('123', true, false);
  t.mock.timers.tick(9000);
  await style;
  assert.equal(children[0].kills, 0);
  t.mock.timers.tick(500);
  children[0].reply('True');
  await input;
  assert.equal(children[0].kills, 1);
});

test('a timed-out activation still retires the helper instead of allowing a late window write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const input = assert.rejects(adapter.inputPolicy('123', true, false), { code: 'NATIVE_TIMEOUT' });
  const activation = adapter.activate('123');
  t.mock.timers.tick(3000);
  assert.equal(await activation, false);
  await input;
  assert.equal(children[0].kills, 1);
  const next = adapter.foreground();
  assert.equal(children.length, 2);
  assert.deepEqual(
    children[1].requests.map((request) => request.kind),
    ['fg'],
  );
  children[1].reply('5678');
  assert.equal(await next, '5678');
});

test('dispose interrupts draining immediately and old deadlines cannot kill the replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const input = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_DISPOSED',
  });
  const query = adapter.foreground();
  t.mock.timers.tick(3000);
  await query;
  adapter.dispose();
  await input;
  assert.equal(children[0].kills, 1);
  const next = adapter.foreground();
  children[1].reply('5678');
  assert.equal(await next, '5678');
  t.mock.timers.tick(10000);
  assert.equal(children[1].kills, 0);
});
