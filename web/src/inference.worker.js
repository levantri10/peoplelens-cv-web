import { ByteTracker } from './tracking.js';
import { decodeYolo, letterboxGeometry, rgbaToTensor } from './detection.js';

// No top-level await: install the message listener before importing a runtime or fetching assets.
let ort = null, session = null, provider = null, tracker = null, confidence = .32, peak = 0;
const seen = new Set();
const canvas = new OffscreenCanvas(640, 640);
const context = canvas.getContext('2d', { willReadFrequently: true });
const runtimeFiles = {
  webgpu: { module: 'ort.webgpu.min.mjs', binding: 'ort-wasm-simd-threaded.asyncify.mjs', binary: 'ort-wasm-simd-threaded.asyncify.wasm' },
  wasm: { module: 'ort.wasm.min.mjs', binding: 'ort-wasm-simd-threaded.mjs', binary: 'ort-wasm-simd-threaded.wasm' },
};

async function downloadBytes(url, expectedBytes, progress, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Không tải được tài nguyên (${response.status}): ${new URL(url, self.location.origin).pathname}`);
  const total = expectedBytes || Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader(), chunks = []; let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (expectedBytes && received > expectedBytes) throw new Error('Kích thước model không hợp lệ.');
    chunks.push(value); progress({ received, total, progress: total ? Math.min(100, Math.round(received / total * 100)) : null });
  }
  if (expectedBytes && received !== expectedBytes) throw new Error('Model tải chưa đầy đủ. Hãy thử lại.');
  const data = new Uint8Array(received); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}

async function downloadModel(emit) {
  emit({ type: 'loading', stage: 'model', message: 'Đang đọc thông tin model trên Vercel…', progress: null });
  const response = await fetch('/models/manifest.json', { cache: 'no-cache', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Không tải được thông tin model.');
  const metadata = await response.json();
  const url = `${metadata.url}?v=${metadata.sha256}`;
  const data = await downloadBytes(url, metadata.bytes, state => emit({ type: 'loading', stage: 'model',
    message: 'Đang tải model đã có sẵn trên Vercel…', ...state }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (checksum !== metadata.sha256) throw new Error('Checksum model không khớp. Hãy tải lại trang để lấy phiên bản mới.');
  return data;
}

async function load(backend, emit) {
  if (session && provider === backend) return;
  if (!runtimeFiles[backend]) throw new Error('Thiết bị xử lý không hợp lệ.');
  if (backend === 'webgpu' && !navigator.gpu) throw new Error('Trình duyệt chưa có WebGPU.');
  const files = runtimeFiles[backend];
  emit({ type: 'loading', stage: 'runtime-import', message: 'Đang mở bộ nhận diện…', progress: null });
  ort = await import(/* @vite-ignore */ `/ort/${files.module}`);
  const runtimeResponse = await fetch('/ort/manifest.json', { cache: 'no-cache', signal: AbortSignal.timeout(30000) });
  if (!runtimeResponse.ok) throw new Error('Không tải được thông tin bộ xử lý. Hãy tải lại trang.');
  const runtimeMetadata = await runtimeResponse.json();
  const runtimeBytes = runtimeMetadata.files[files.binary]?.bytes;
  if (!Number.isSafeInteger(runtimeBytes) || runtimeBytes <= 0) throw new Error('Thiếu thông tin WASM của phiên bản hiện tại.');
  // One WASM thread avoids a nested-worker initialization deadlock; GPU execution stays on WebGPU.
  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
  ort.env.wasm.initTimeout = 30000;
  ort.env.wasm.wasmPaths = {
    mjs: new URL(`/ort/${files.binding}`, self.location.origin).href,
    wasm: new URL(`/ort/${files.binary}`, self.location.origin).href,
  };
  const model = await downloadModel(emit);
  ort.env.wasm.wasmBinary = await downloadBytes(`/ort/${files.binary}`, runtimeBytes,
    state => emit({ type: 'loading', stage: 'runtime-download',
      message: `Đang tải bộ xử lý ${backend === 'webgpu' ? 'GPU' : 'CPU'}…`, ...state }));
  emit({ type: 'loading', stage: backend === 'webgpu' ? 'gpu-init' : 'cpu-init',
    message: backend === 'webgpu' ? 'Đang khởi tạo GPU; sẽ tự chuyển CPU nếu quá 15 giây…' : 'Đang khởi tạo CPU…', progress: null });
  session = await ort.InferenceSession.create(model, { executionProviders: [backend], graphOptimizationLevel: 'all' });
  emit({ type: 'loading', stage: backend === 'webgpu' ? 'gpu-warmup' : 'cpu-init',
    message: 'Model đã tải xong. Đang chạy thử khung hình đầu tiên…', progress: null });
  const input = new ort.Tensor('float32', new Float32Array(3 * 640 * 640), [1, 3, 640, 640]);
  try {
    const outputs = await session.run({ [session.inputNames[0]]: input });
    Object.values(outputs).forEach(value => value.dispose());
  } finally { input.dispose(); }
  provider = backend;
}

self.onmessage = async event => {
  const message = event.data;
  const emit = response => self.postMessage({ ...response, id: message.id });
  try {
    if (message.type === 'init') {
      await load(message.backend, emit);
      tracker = new ByteTracker(); confidence = message.confidence; peak = 0; seen.clear();
      emit({ type: 'ready', provider, threads: 1 });
    }
    if (message.type === 'frame') {
      if (!session || !tracker) throw new Error('Model chưa sẵn sàng.');
      const started = performance.now(), bitmap = message.bitmap;
      const geometry = letterboxGeometry(bitmap.width, bitmap.height);
      context.fillStyle = 'rgb(114,114,114)'; context.fillRect(0, 0, 640, 640);
      context.drawImage(bitmap, geometry.padX, geometry.padY, geometry.resizedWidth, geometry.resizedHeight);
      const input = new ort.Tensor('float32', rgbaToTensor(context.getImageData(0, 0, 640, 640).data), [1, 3, 640, 640]);
      let outputs;
      try { outputs = await session.run({ [session.inputNames[0]]: input }); } finally { input.dispose(); }
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
      self.postMessage({ type: 'result', id: message.id, record, bitmap }, [bitmap]);
    }
  } catch (error) {
    message.bitmap?.close(); emit({ type: 'error', message: error.message || String(error) });
  }
};
self.postMessage({ type: 'booted' });
