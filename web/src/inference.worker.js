import { ByteTracker } from './tracking.js';
import { decodeYolo, letterboxGeometry, rgbaToTensor } from './detection.js';

// Serve the vendor module unchanged so its WASM loader resolves relative to /ort/.
const ort = await import(/* @vite-ignore */ '/ort/ort.webgpu.min.mjs');

let session = null, provider = null, preference = null, tracker = null, confidence = .32, peak = 0;
const seen = new Set();
const canvas = new OffscreenCanvas(640, 640);
const context = canvas.getContext('2d', { willReadFrequently: true });
ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
ort.env.wasm.proxy = false;

async function downloadModel() {
  const metadataResponse = await fetch('/models/manifest.json');
  if (!metadataResponse.ok) throw new Error('Không tải được thông tin model.');
  const metadata = await metadataResponse.json();
  const response = await fetch(metadata.url);
  if (!response.ok) throw new Error('Không tải được model nhận diện.');
  const reader = response.body.getReader();
  const data = new Uint8Array(metadata.bytes);
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > data.length) throw new Error('Kích thước model không hợp lệ.');
    data.set(value, received); received += value.length;
    self.postMessage({ type: 'loading', progress: Math.round(received / data.length * 100), message: 'Đang tải model về thiết bị…' });
  }
  if (received !== data.length) throw new Error('Model tải chưa đầy đủ. Hãy thử lại.');
  const digest = await crypto.subtle.digest('SHA-256', data);
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (checksum !== metadata.sha256) throw new Error('Checksum model không khớp. Hãy tải lại trang.');
  return data;
}

async function load(requested) {
  const wantGpu = requested !== 'wasm' && !!navigator.gpu;
  if (session && ((requested === 'wasm' && provider === 'wasm') || (requested === 'auto' && preference === 'auto'))) return;
  if (session) { await session.release(); session = null; }
  const model = await downloadModel();
  preference = requested;
  if (wantGpu) {
    try {
      session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      provider = 'webgpu';
      // Warm up before video playback so initialization doesn't skip the start of a file.
      const input = new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
      try {
        const warm = await session.run({ [session.inputNames[0]]: input });
        Object.values(warm).forEach(value => value.dispose());
      } finally { input.dispose(); }
      return;
    } catch (error) {
      if (session) await session.release().catch(() => {});
      session = null;
      self.postMessage({ type: 'loading', message: 'GPU chưa tương thích. Đang chuyển sang CPU…', progress: 100 });
    }
  }
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  provider = 'wasm';
}

self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      await load(message.backend);
      tracker = new ByteTracker(); confidence = message.confidence; peak = 0; seen.clear();
      self.postMessage({ type: 'ready', provider, threads: ort.env.wasm.numThreads });
    }
    if (message.type === 'frame') {
      if (!session || !tracker) throw new Error('Model chưa sẵn sàng.');
      const started = performance.now(), bitmap = message.bitmap;
      const geometry = letterboxGeometry(bitmap.width, bitmap.height);
      context.fillStyle = 'rgb(114,114,114)'; context.fillRect(0, 0, 640, 640);
      context.drawImage(bitmap, geometry.padX, geometry.padY, geometry.resizedWidth, geometry.resizedHeight);
      const input = new ort.Tensor('float32', rgbaToTensor(context.getImageData(0, 0, 640, 640).data), [1, 3, 640, 640]);
      let outputs;
      try { outputs = await session.run({ [session.inputNames[0]]: input }); }
      finally { input.dispose(); }
      let detections;
      try { detections = decodeYolo(outputs[session.outputNames[0]], geometry, .1); }
      finally { Object.values(outputs).forEach(value => value.dispose()); }
      tracker.update(detections, message.timestamp_ms);
      detections = detections.filter(detection => detection.confidence >= confidence);
      detections.forEach(detection => { if (detection.track_id !== null) seen.add(detection.track_id); });
      peak = Math.max(peak, detections.length);
      const record = { frame_index: message.frame_index, timestamp_ms: message.timestamp_ms,
        recorded_at: new Date().toISOString(), frame_width: bitmap.width, frame_height: bitmap.height,
        people_count: detections.length, tracked_count: detections.filter(d => d.track_id !== null).length,
        peak_count: peak, unique_track_count: seen.size, processing_ms: Math.round((performance.now() - started) * 100) / 100,
        detections: detections.map(d => ({ ...d, confidence: Math.round(d.confidence * 1e4) / 1e4,
          bbox_xyxy: d.bbox_xyxy.map(value => Math.round(value * 100) / 100) })) };
      self.postMessage({ type: 'result', record, bitmap }, [bitmap]);
    }
  } catch (error) {
    message.bitmap?.close();
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
