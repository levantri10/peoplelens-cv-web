import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteTracker, assign } from '../src/tracking.js';
import { decodeYolo, letterboxGeometry, rgbaToTensor } from '../src/detection.js';
import { countsCsv, recordsJsonl, summary } from '../src/session.js';
import { readFile } from 'node:fs/promises';

const detection = (x, score = .9) => ({ bbox_xyxy: [x, 10, x + 30, 90], confidence: score });

test('global association avoids greedy assignment that loses a valid second track', () => {
  const result = assign([[.1, .15], [.12, .9]], .5);
  assert.deepEqual(result.matches.sort(), [[0, 1], [1, 0]]);
  assert.equal(assign([[.9]], .5).matches.length, 0);
});
test('ByteTrack preserves IDs for two independently moving people', () => {
  const tracker = new ByteTracker();
  let firstIds;
  for (let i = 0; i < 15; i++) {
    const result = tracker.update([detection(10 + i * 2), detection(200 - i * 2)], i * 100);
    const ids = result.map(d => d.track_id);
    if (!firstIds) firstIds = ids;
    assert.deepEqual(ids, firstIds);
    assert.notEqual(ids[0], ids[1]);
  }
});
test('low-confidence recovery keeps an existing ID without creating new low-score tracks', () => {
  const tracker = new ByteTracker();
  const id = tracker.update([detection(20)], 0)[0].track_id;
  const recovered = tracker.update([detection(21, .18), detection(400, .15)], 100);
  assert.equal(recovered[0].track_id, id); assert.equal(recovered[1].track_id, null);
  assert.equal(tracker.update([detection(23)], 200)[0].track_id, id);
});
test('empty frames age tracks; brief occlusion reuses ID, expiration requires confirmation', () => {
  const tracker = new ByteTracker({ lostBufferMs: 1000 });
  const id = tracker.update([detection(20)], 0)[0].track_id;
  assert.deepEqual(tracker.update([], 100), []);
  assert.equal(tracker.update([detection(21)], 300)[0].track_id, id);
  tracker.update([], 1500);
  assert.equal(tracker.update([detection(21)], 1600)[0].track_id, null);
  const newId = tracker.update([detection(21)], 1700)[0].track_id;
  assert.ok(newId !== null && newId !== id);
  assert.equal(new ByteTracker().update([detection(21)], 0)[0].track_id, 1);
});
test('YOLO decoding reverses letterbox, suppresses duplicates and drops invalid boxes', () => {
  const geometry = letterboxGeometry(1280, 720);
  const data = Float32Array.from([320, 320, 200, 320, 320, 200, 100, 100, -1, 200, 200, 50, .9, .8, .99]);
  const detections = decodeYolo({ dims: [1, 5, 3], data }, geometry);
  assert.equal(detections.length, 1);
  assert.deepEqual(detections[0].bbox_xyxy, [540, 160, 740, 560]);
  assert.deepEqual(Array.from(rgbaToTensor(Uint8Array.from([255, 128, 0, 255]), 1)).map(n => Math.round(n * 255)), [255, 128, 0]);
});
test('exports retain zero counts and timestamps without persisting a video', () => {
  const records = [{ session_id: 'test', source_type: 'video', frame_index: 0, timestamp_ms: 0, recorded_at: '2026-10-28T00:00:00Z', people_count: 0, tracked_count: 0, peak_count: 0, unique_track_count: 0, processing_ms: 10 }];
  const csv = countsCsv(records), jsonl = recordsJsonl(records);
  assert.ok(csv.includes('test,video,0,0,2026-10-28T00:00:00Z,0,0,0,0,10'));
  assert.equal(JSON.parse(jsonl).people_count, 0);
  const result = summary({ id: 'test', records, timeline: [], latest: records[0] });
  assert.equal(result.frames_uploaded, false); assert.equal(result.storage, 'tab-memory-only');
});
test('public client uses no upload endpoints, remote inference or persistent video storage', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../src/inference.worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app + worker, /localStorage|sessionStorage|indexedDB|FormData|XMLHttpRequest|WebSocket|\/api\/jobs/);
  assert.doesNotMatch(app + worker, /method:\s*['"]POST['"]/);
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.ok(config.headers[0].headers.some(header => header.key === 'Content-Security-Policy' && header.value.includes("connect-src 'self'")));
});
