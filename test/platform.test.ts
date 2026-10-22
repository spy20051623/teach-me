import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pruneSessions } from '../src/host/storage.ts';
import { transcribe } from '../src/host/speech.ts';

async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teach-me-platform-'));
  return {
    root,
    cleanup: async () => {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('teach-me-platform-'));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
test('retention only removes expired session directories inside its own root', async () => {
  const { root, cleanup } = await temporary();
  try {
    const old = path.join(root, 'sessions', randomUUID());
    const recent = path.join(root, 'sessions', randomUUID());
    const other = path.join(root, 'sessions', 'user-folder');
    for (const folder of [old, recent, other]) await fs.mkdir(folder, { recursive: true });
    const earlier = new Date(Date.now() - 10 * 86400000);
    await fs.utimes(old, earlier, earlier);
    await fs.utimes(other, earlier, earlier);
    await pruneSessions(root, 7);
    await assert.rejects(fs.access(old));
    await fs.access(recent);
    await fs.access(other);
  } finally {
    await cleanup();
  }
});
test('failed local recognition still deletes the temporary audio file', async () => {
  const { root, cleanup } = await temporary();
  try {
    await assert.rejects(
      transcribe(
        new Uint8Array([0, 255]),
        'audio/webm',
        { engine: 'local', customUrl: '', localCommand: path.join(root, 'missing-recognizer.exe') },
        root,
      ),
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await cleanup();
  }
});

test('a partial audio write failure removes the file without starting a recognizer', async (t) => {
  const { root, cleanup } = await temporary();
  const writeFile = fs.writeFile;
  const failure = new Error('fixture disk write failed after partial data');
  let launches = 0;
  t.mock.method(fs, 'writeFile', async (file: string) => {
    await writeFile(file, new Uint8Array([1]));
    throw failure;
  });
  t.mock.method(childProcess, 'spawn', () => {
    launches++;
    throw new Error('recognizer must not start after a failed write');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      transcribe(
        new Uint8Array([1, 2, 3]),
        'audio/webm',
        { engine: 'local', customUrl: '', localCommand: 'fixture-recognizer' },
        root,
      ),
      (error) => error === failure,
    );
    assert.equal(launches, 0);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup();
  }
});
test('custom recognizer sends bytes to the configured local HTTP API and reads transcript', async () => {
  let received = 0;
  const server = createServer(async (req, res) => {
    for await (const bytes of req) received += bytes.length;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: '测试识别' }));
  });
  // Windows can allocate an ephemeral port that fetch refuses as an unsafe service port.
  // Use the private high range, retrying only address collisions, not request failures.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(randomInt(49152, 65536), '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 9) throw error;
    }
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const text = await transcribe(
      new Uint8Array([1, 2, 3]),
      'audio/webm',
      { engine: 'custom', customUrl: `http://127.0.0.1:${address.port}`, localCommand: '' },
      os.tmpdir(),
    );
    assert.equal(text, '测试识别');
    assert.equal(received, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
