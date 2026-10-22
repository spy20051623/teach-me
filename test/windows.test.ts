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
  async reply(value: string) {
    await flush();
    const request = this.requests.at(-1)!;
    this.stdout.emit('data', `@${request.id}=${value}\n`);
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ready(child: FakeChild) {
  child.stdout.emit('data', '@READY\n');
  await flush();
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

test('startup sends no business command before READY', async (t) => {
  const { adapter, children } = setup(t);
  const pending = adapter.foreground();
  assert.equal(
    children[0].requests.length,
    0,
    'startup must not queue business writes before READY',
  );
  children[0].stdout.emit('data', '@READY\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(children[0].requests.length, 1);
  await children[0].reply('5678');
  assert.equal(await pending, '5678');
});

test('an old helper exit cannot end a request sent to its replacement', async (t) => {
  const { adapter, children } = setup(t);
  const first = adapter.foreground();
  const old = children[0];
  await ready(old);
  adapter.dispose();
  const second = adapter.foreground();
  const current = children[1];
  await ready(current);
  old.emit('exit', 0, null);
  await current.reply('5678');
  assert.equal(await first, null);
  assert.equal(await second, '5678');
  const third = adapter.foreground();
  assert.equal(children.length, 2, 'the healthy replacement is reused');
  await current.reply('9012');
  assert.equal(await third, '9012');
});

test('an incomplete old helper line cannot consume the replacement response', async (t) => {
  const { adapter, children } = setup(t);
  const first = adapter.foreground();
  const old = children[0];
  await ready(old);
  old.stdout.emit('data', `@${old.requests[0].id}=12`);
  old.emit('exit', 0, null);
  assert.equal(await first, null);
  const second = adapter.foreground();
  await ready(children[1]);
  await children[1].reply('5678');
  assert.deepEqual(await settledByNextTurn(second), { value: '5678' });
});

test('dispose ends pending requests without waiting for the helper exit event', async (t) => {
  const { adapter, children } = setup(t);
  const pending = adapter.foreground();
  await ready(children[0]);
  assert.equal(children[0].requests.length, 1);
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
    if (kind === 'exit' || kind === 'write-event') await ready(children[0]);
    if (kind === 'spawn-event') children[0].emit('error', new Error('PRIVATE_SPAWN_FAILURE'));
    if (kind === 'exit') children[0].emit('exit', 19, null);
    if (kind === 'write-event') children[0].stdin.emit('error', new Error('PRIVATE_WRITE_FAILURE'));
    if (kind === 'write-throw') await ready(children[0]);
    await failed;
    options.spawnFailure = undefined;
    options.configure = undefined;
    const next = adapter.windowStyle('1234567');
    await ready(children.at(-1)!);
    await children.at(-1)!.reply('524288');
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
  await ready(children[0]);
  await children[0].reply('False');
  await rejected;
  const malformed = assert.rejects(adapter.windowStyle('123'), {
    code: 'NATIVE_PROTOCOL_ERROR',
  });
  await children[0].reply('PRIVATE_INVALID_STYLE');
  await malformed;
  const exception = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_PROTOCOL_ERROR',
  });
  await children[0].reply('!ERROR');
  await exception;
  const success = adapter.inputPolicy('123', true, false);
  await children[0].reply('True');
  await success;
});

test('timed-out helper is retired and its late events cannot affect the replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children, reports } = setup(t);
  const failed = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_TIMEOUT',
  });
  const old = children[0];
  await ready(old);
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
  await ready(children[1]);
  await old.reply('True');
  old.stdout.emit('data', '@READY\n@999=');
  old.emit('exit', 1, null);
  old.stdin.emit('error', new Error('late old pipe error'));
  await children[1].reply('524288');
  assert.equal(await next, 524288);
  const foreground = adapter.foreground();
  assert.equal(children.length, 2, 'healthy replacement remains reusable');
  await children[1].reply('5678');
  assert.equal(await foreground, '5678');
});

test('startup timeout reports not-ready and stderr byte count without raw data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children, reports } = setup(t);
  const failed = assert.rejects(adapter.windowStyle('1234567'), {
    code: 'NATIVE_HELPER_EXIT_TIMEOUT',
  });
  const stderr = Buffer.from('PRIVATE_COMMAND_AND_HANDLE_1234567\n故障');
  children[0].stderr.emit('data', stderr);
  t.mock.timers.tick(10000);
  await flush();
  t.mock.timers.tick(2000);
  await failed;
  assert.ok(
    reports.some(
      (entry) =>
        entry.event === 'native-helper-ended' &&
        entry.detail.reason === 'startup-timeout' &&
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
  await ready(children[0]);
  await children[0].reply('True');
  await pending;
  const foreground = adapter.foreground();
  await flush();
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
    if (ready) {
      child.stdout.emit('data', '@READY\n');
      await flush();
    }
    const foreground = adapter.foreground();
    const down = adapter.talkDown();
    if (!ready) child.stdout.emit('data', '@READY\n');
    await flush();
    const input = child.requests.find((request) => request.kind === 'input')!;
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
  await ready(old);
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
  await ready(children[1]);
  await old.reply('999');
  old.emit('exit', 1);
  await children[1].reply('524288');
  assert.equal(await next, 524288);
});

test('a style read timeout does not shorten a later window write deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const style = assert.rejects(adapter.windowStyle('123'), { code: 'NATIVE_TIMEOUT' });
  await ready(children[0]);
  t.mock.timers.tick(1000);
  const input = adapter.inputPolicy('123', true, false);
  await flush();
  t.mock.timers.tick(9000);
  await style;
  assert.equal(children[0].kills, 0);
  t.mock.timers.tick(500);
  await children[0].reply('True');
  await input;
  assert.equal(children[0].kills, 1);
});

test('a timed-out activation still retires the helper instead of allowing a late window write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const input = assert.rejects(adapter.inputPolicy('123', true, false), { code: 'NATIVE_TIMEOUT' });
  const activation = adapter.activate('123');
  await ready(children[0]);
  t.mock.timers.tick(3000);
  assert.equal(await activation, false);
  await input;
  assert.equal(children[0].kills, 1);
  const next = adapter.foreground();
  assert.equal(children.length, 2);
  await ready(children[1]);
  assert.deepEqual(
    children[1].requests.map((request) => request.kind),
    ['fg'],
  );
  await children[1].reply('5678');
  assert.equal(await next, '5678');
});

test('dispose interrupts draining immediately and old deadlines cannot kill the replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const input = assert.rejects(adapter.inputPolicy('123', true, false), {
    code: 'NATIVE_DISPOSED',
  });
  const query = adapter.foreground();
  await ready(children[0]);
  t.mock.timers.tick(3000);
  await query;
  adapter.dispose();
  await input;
  assert.equal(children[0].kills, 1);
  const next = adapter.foreground();
  await ready(children[1]);
  await children[1].reply('5678');
  assert.equal(await next, '5678');
  t.mock.timers.tick(10000);
  assert.equal(children[1].kills, 0);
});

test('delayed READY preserves the complete three and ten second operation deadlines', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const input = assert.rejects(adapter.inputPolicy('123', true, false), { code: 'NATIVE_TIMEOUT' });
  let queryFinished = false;
  const query = adapter.foreground().then((value) => {
    queryFinished = true;
    return value;
  });
  const child = children[0];
  t.mock.timers.tick(9000);
  await flush();
  assert.equal(child.requests.length, 0);
  assert.equal(queryFinished, false);
  assert.equal(child.kills, 0);
  await ready(child);
  assert.equal(child.requests.length, 2);
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(queryFinished, false);
  t.mock.timers.tick(1);
  assert.equal(await query, null);
  t.mock.timers.tick(6999);
  assert.equal(child.kills, 0, 'input retains its own complete operation deadline');
  t.mock.timers.tick(1);
  await input;
  assert.equal(child.kills, 1);
  assert.equal(
    children.length,
    1,
    'already-sent commands are never replayed after an operation timeout',
  );
});

test('concurrent startup waiters share one retry only after confirmed old exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const input = adapter.inputPolicy('123', true, false);
  const style = adapter.windowStyle('123');
  const query = adapter.foreground();
  assert.equal(children.length, 1);
  const old = children[0];
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(old.kills, 1);
  assert.equal(old.requests.length, 0);
  const down = adapter.talkDown();
  old.stdout.emit('data', '@READY\n');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(children.length, 1, 'a kill request is not proof of process exit');
  old.emit('exit', 0, null);
  await flush();
  assert.equal(children.length, 2);
  const current = children[1];
  assert.equal(current.requests.length, 0);
  await ready(current);
  assert.equal(current.requests.length, 4);
  assert.deepEqual(current.requests.map((request) => request.kind).sort(), [
    'down',
    'fg',
    'input',
    'style',
  ]);
  assert.equal(new Set(current.requests.map((request) => request.id)).size, 4);
  old.stdout.emit('data', '@READY\n@999=PRIVATE_LATE_REPLY\n');
  old.emit('exit', 1, null);
  for (const request of current.requests) {
    const value = request.kind === 'fg' ? '5678' : request.kind === 'style' ? '524288' : 'True';
    current.stdout.emit('data', `@${request.id}=${value}\n`);
  }
  await input;
  assert.equal(await style, 524288);
  assert.equal(await query, '5678');
  assert.equal(await down, true);
  assert.equal(old.requests.length, 0, 'the first process never receives any business command');
  assert.equal(current.kills, 0);
});

test('two startup deadlines fail boundedly without a third helper or a business replay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  const failed = adapter.inputPolicy('123', true, false).then(
    () => 'unexpected success',
    (error) => error.code,
  );
  t.mock.timers.tick(10000);
  await flush();
  children[0].emit('exit', 0, null);
  await flush();
  assert.equal(children.length, 2);
  t.mock.timers.tick(10000);
  await flush();
  assert.deepEqual(await settledByNextTurn(failed), { value: 'NATIVE_STARTUP_TIMEOUT' });
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.requests.length === 0 && child.kills === 1));
});

test('missing exit confirmation stops retry after two seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children } = setup(t);
  let finished = false;
  const failed = adapter.inputPolicy('123', true, false).then(
    () => 'unexpected success',
    (error) => {
      finished = true;
      return error.code;
    },
  );
  t.mock.timers.tick(10000);
  await flush();
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await settledByNextTurn(failed), { value: 'NATIVE_HELPER_EXIT_TIMEOUT' });
  children[0].emit('exit', 0, null);
  t.mock.timers.tick(20000);
  await flush();
  assert.equal(children.length, 1, 'late exit cannot resurrect an expired retry');
  assert.equal(children[0].requests.length, 0);
});

for (const attempt of [1, 2]) {
  test(`startup retirement after attempt ${attempt} blocks polling and dispose until actual exit`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { adapter, children } = setup(t);
    const failed = adapter.inputPolicy('123', true, false).then(
      () => 'unexpected success',
      (error) => error.code,
    );
    t.mock.timers.tick(10000);
    await flush();
    if (attempt === 2) {
      children[0].emit('exit', 0, null);
      await flush();
      t.mock.timers.tick(10000);
      await flush();
    } else {
      t.mock.timers.tick(2000);
      await flush();
    }
    assert.deepEqual(await settledByNextTurn(failed), {
      value: attempt === 1 ? 'NATIVE_HELPER_EXIT_TIMEOUT' : 'NATIVE_STARTUP_TIMEOUT',
    });
    const retired = children.at(-1)!;
    assert.equal(children.length, attempt);
    retired.stdout.emit('data', '@READY\n');
    for (let poll = 0; poll < 3; poll++) {
      if (poll === 1) adapter.dispose();
      const query = adapter.foreground();
      const input = adapter.inputPolicy('123', true, false).then(
        () => 'unexpected success',
        (error) => error.code,
      );
      await flush();
      assert.equal(children.length, attempt, 'unconfirmed exit must not accumulate helpers');
      assert.deepEqual(await settledByNextTurn(query), { value: null });
      assert.deepEqual(await settledByNextTurn(input), { value: 'NATIVE_HELPER_EXIT_TIMEOUT' });
      t.mock.timers.tick(30000);
      await flush();
    }
    assert.equal(retired.kills, 1);
    assert.ok(children.every((child) => child.requests.length === 0));
    retired.emit('exit', 0, null);
    await flush();
    assert.equal(children.length, attempt, 'late exit alone must not restart a failed request');
    const next = adapter.foreground();
    assert.equal(children.length, attempt + 1);
    const current = children.at(-1)!;
    await ready(current);
    assert.deepEqual(
      current.requests.map((request) => request.kind),
      ['fg'],
    );
    await current.reply('5678');
    assert.equal(await next, '5678');
  });
}

for (const phase of ['first-start', 'waiting-exit', 'retry-start']) {
  test(`dispose cancels ${phase} and only a later explicit call may create a helper`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { adapter, children } = setup(t);
    const input = adapter.inputPolicy('123', true, false).then(
      () => 'unexpected success',
      (error) => error.code,
    );
    const query = adapter.foreground();
    if (phase !== 'first-start') {
      t.mock.timers.tick(10000);
      await flush();
      if (phase === 'retry-start') {
        children[0].emit('exit', 0, null);
        await flush();
        assert.equal(children.length, 2);
      }
    }
    adapter.dispose();
    assert.deepEqual(await settledByNextTurn(input), { value: 'NATIVE_DISPOSED' });
    assert.equal(await query, null);
    const retiredCount = children.length;
    if (phase === 'waiting-exit') {
      const blocked = adapter.foreground();
      await flush();
      assert.equal(children.length, retiredCount, 'dispose cannot bypass exit confirmation');
      assert.deepEqual(await settledByNextTurn(blocked), { value: null });
    }
    for (const child of children) {
      child.stdout.emit('data', '@READY\n');
      child.emit('exit', 0, null);
    }
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(children.length, retiredCount);
    assert.ok(children.every((child) => child.requests.length === 0));
    const next = adapter.foreground();
    assert.equal(children.length, retiredCount + 1);
    const current = children.at(-1)!;
    await ready(current);
    await current.reply('5678');
    assert.equal(await next, '5678');
  });
}

test('startup ENTER and READY report elapsed milestones without private command output', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { adapter, children, reports } = setup(t);
  const pending = adapter.foreground();
  const child = children[0];
  t.mock.timers.tick(250);
  child.stdout.emit('data', '@EN');
  t.mock.timers.tick(250);
  child.stdout.emit('data', 'TER\nPRIVATE_HANDLE_1234567\n');
  child.stderr.emit('data', Buffer.from('PRIVATE_STDERR_1234567'));
  t.mock.timers.tick(1200);
  await ready(child);
  await child.reply('5678');
  assert.equal(await pending, '5678');
  assert.ok(
    reports.some(
      (entry) => entry.event === 'native-helper-enter' && entry.detail.elapsedMs === 500,
    ),
  );
  assert.ok(
    reports.some(
      (entry) => entry.event === 'native-helper-ready' && entry.detail.elapsedMs === 1700,
    ),
  );
  adapter.dispose();
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE_|1234567/);
});
