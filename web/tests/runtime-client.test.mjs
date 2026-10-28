import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { RuntimeClient, WorkerConnection, RuntimeTimeoutError } from '../src/runtime-client.js';

class FakeWorker {
  constructor(handler = () => {}) { this.handler = handler; this.messages = []; this.terminated = false; }
  send(message) { this.onmessage?.({ data: message }); }
  postMessage(message) { this.messages.push(message); this.handler(message, this); }
  terminate() { this.terminated = true; }
}
const budget = { bootTimeoutMs: 100, requestTimeoutMs: 100, gpuTimeoutMs: 15, cpuTimeoutMs: 100 };

test('startup waits for the worker handshake before sending init', async () => {
  const worker = new FakeWorker((request, target) => queueMicrotask(() => target.send({ type: 'ready', id: request.id, provider: 'wasm' })));
  const connection = new WorkerConnection(() => worker, budget);
  const result = connection.request({ type: 'init' });
  assert.equal(worker.messages.length, 0);
  worker.send({ type: 'booted' });
  assert.equal((await result).provider, 'wasm');
  assert.equal(worker.messages.length, 1); connection.close();
});
test('a worker that never boots is terminated and reports a timeout', async () => {
  const worker = new FakeWorker();
  const connection = new WorkerConnection(() => worker, { ...budget, bootTimeoutMs: 10 });
  await assert.rejects(connection.request({ type: 'init' }), RuntimeTimeoutError);
  assert.equal(worker.terminated, true);
});
test('GPU startup hang falls back to CPU in a fresh worker', async () => {
  const workers = [], updates = [];
  const client = new RuntimeClient(() => {
    const worker = new FakeWorker((request, target) => {
      if (request.backend === 'webgpu') target.send({ type: 'loading', id: request.id, stage: 'gpu-init' });
      else target.send({ type: 'ready', id: request.id, provider: 'wasm', threads: 1 });
    });
    workers.push(worker); queueMicrotask(() => worker.send({ type: 'booted' })); return worker;
  }, { ...budget, onProgress: message => updates.push(message) });
  const result = await client.initialize({ backend: 'auto' });
  assert.equal(result.provider, 'wasm'); assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  assert.ok(updates.some(message => message.stage === 'fallback'));
  assert.equal(workers[1].messages[0].backend, 'wasm'); client.close();
});
test('stopping GPU startup cancels the request without launching CPU', async () => {
  const workers = []; let began;
  const begun = new Promise(resolve => { began = resolve; });
  const client = new RuntimeClient(() => {
    const worker = new FakeWorker(() => began()); workers.push(worker);
    queueMicrotask(() => worker.send({ type: 'booted' })); return worker;
  }, budget);
  const result = client.initialize({ backend: 'auto' });
  await begun; client.close();
  await assert.rejects(result, error => error.name === 'AbortError');
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);
});
test('old responses cannot complete a later request', async () => {
  const worker = new FakeWorker();
  const connection = new WorkerConnection(() => worker, budget);
  worker.send({ type: 'booted' });
  const first = connection.request({ type: 'init' }); await Promise.resolve();
  worker.send({ type: 'ready', id: 1, provider: 'wasm' }); await first;
  const second = connection.request({ type: 'frame' }); await Promise.resolve();
  worker.send({ type: 'result', id: 1, record: 'stale' });
  assert.equal(connection.pending.id, 2);
  worker.send({ type: 'result', id: 2, record: 'current' });
  assert.equal((await second).record, 'current'); connection.close();
});
test('a compiled CPU session is reused while each run still gets an init/reset', async () => {
  let count = 0;
  const client = new RuntimeClient(() => {
    count++;
    const worker = new FakeWorker((request, target) => target.send({ type: 'ready', id: request.id, provider: 'wasm' }));
    queueMicrotask(() => worker.send({ type: 'booted' })); return worker;
  }, budget);
  await client.initialize({ backend: 'wasm', confidence: .32 });
  await client.initialize({ backend: 'wasm', confidence: .5 });
  assert.equal(count, 1); assert.equal(client.connection.worker.messages.length, 2); client.close();
});
test('worker installs its listener and announces readiness without awaiting vendor imports', async () => {
  const source = (await readFile(new URL('../src/inference.worker.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const messages = [];
  const self = { postMessage: message => messages.push(message) };
  const context = { self, OffscreenCanvas: class { getContext() { return {}; } } };
  vm.runInNewContext(source, context);
  assert.equal(typeof self.onmessage, 'function');
  assert.deepEqual(messages.map(message => message.type), ['booted']);
});
