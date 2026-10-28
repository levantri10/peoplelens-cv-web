import { countsCsv, recordsJsonl, summary } from './session.js';
import { RuntimeClient } from './runtime-client.js';

const $ = id => document.getElementById(id);
const statusNames = { loading: 'Đang chuẩn bị', processing: 'Đang nhận diện', live: 'Trực tiếp', completed: 'Hoàn tất', cancelled: 'Đã dừng', failed: 'Lỗi xử lý' };
let mode = 'video', selectedFile = null, selectedURL = null, active = null, ready = false;
let history = [], downloadUrls = [], cameraStream = null;
const capture = document.createElement('canvas'), captureContext = capture.getContext('2d');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runtime = new RuntimeClient(() => new Worker(new URL('./inference.worker.js', import.meta.url), { type: 'module' }), {
  onProgress(message) {
    if (!active) return;
    const amount = message.received && message.total ? ` ${(message.received / 1048576).toFixed(1)} / ${(message.total / 1048576).toFixed(1)} MB` : '';
    overlay(message.message + amount);
    $('progressArea').hidden = false; $('progressLabel').textContent = message.message;
    if (typeof message.progress === 'number') { $('progressBar').value = message.progress; $('progressValue').textContent = message.progress + '%'; }
    else { $('progressBar').removeAttribute('value'); $('progressValue').textContent = ''; }
  },
});

function notice(message, kind = '') { $('notice').textContent = message; $('notice').className = 'notice ' + kind; $('notice').hidden = !message; }
function overlay(message = '') { $('viewerOverlay').hidden = !message; $('overlayText').textContent = message; }
function badge(status) { $('runBadge').textContent = statusNames[status] || status; $('runBadge').className = 'run-badge ' + (['loading', 'processing', 'live'].includes(status) ? 'running' : status === 'completed' ? 'success' : ''); }
function showMedia(id) { for (const name of ['emptyState', 'player', 'preview', 'liveCanvas']) $(name).hidden = name !== id; $('viewer').classList.toggle('has-media', id !== 'emptyState'); }
function setBusy(value) {
  for (const id of ['videoTab', 'webcamTab', 'confidence', 'backendSelect', 'sampleFps', 'dropzone', 'chooseInline', 'demoButton', 'fileInput', 'cameraSelect', 'clearSession']) $(id).disabled = value;
  $('recordVideo').disabled = value || !('MediaRecorder' in window) || !HTMLCanvasElement.prototype.captureStream;
  $('startButton').hidden = value; $('stopButton').hidden = !value; $('stopButton').disabled = false;
  $('startButton').disabled = !ready || (mode === 'video' && !selectedFile);
  $('demoButton').disabled = value || !ready;
}
function setMode(next) {
  if (active) return;
  mode = next;
  for (const [id, value] of [['videoTab', 'video'], ['webcamTab', 'webcam']]) { $(id).classList.toggle('selected', next === value); $(id).setAttribute('aria-selected', String(next === value)); }
  $('videoControls').hidden = next !== 'video'; $('webcamControls').hidden = next !== 'webcam';
  $('startButton').querySelector('span').textContent = next === 'webcam' ? 'Bật webcam & nhận diện' : 'Bắt đầu nhận diện';
  setBusy(false);
}
function timeLabel(ms, precise = false) {
  const seconds = Math.max(0, ms || 0) / 1000;
  const base = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return precise ? base + '.' + String(Math.floor((ms || 0) % 1000)).padStart(3, '0') : base;
}
function resetMetrics() {
  for (const id of ['peopleCount', 'trackedCount', 'peakCount', 'fpsCount']) $(id).textContent = '—';
  $('downloads').hidden = true; $('resultsEmpty').hidden = false; $('frameLabel').textContent = 'FRAME —'; $('timeLabel').textContent = '00:00.000'; $('progressArea').hidden = true; drawChart([]);
}
function metrics(record, fps) {
  if (!record) return;
  $('peopleCount').textContent = record.people_count; $('trackedCount').textContent = record.tracked_count; $('peakCount').textContent = record.peak_count;
  $('fpsCount').textContent = (fps || 0).toFixed(1); $('frameLabel').textContent = 'MẪU ' + String(record.frame_index).padStart(5, '0');
  $('timeLabel').textContent = timeLabel(record.timestamp_ms, true); $('frameDimensions').textContent = `${record.frame_width} × ${record.frame_height} px`;
}
function drawChart(points) {
  const left = 34, right = 754, top = 12, bottom = 132, max = Math.max(4, ...points.map(p => p.people_count));
  $('chartGrid').replaceChildren();
  for (let i = 0; i < 3; i++) {
    const y = top + (bottom - top) * i / 2;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [key, value] of Object.entries({ x1: left, x2: right, y1: y, y2: y, stroke: '#edf0f4', 'stroke-dasharray': '3 5' })) line.setAttribute(key, value);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    for (const [key, value] of Object.entries({ x: 2, y: y + 3, fill: '#a7afbb', 'font-size': 9 })) text.setAttribute(key, value);
    text.textContent = String(Math.round(max * (1 - i / 2))); $('chartGrid').append(line, text);
  }
  $('chartEmpty').hidden = !!points.length;
  if (!points.length) { $('chartLine').setAttribute('d', ''); $('chartArea').setAttribute('d', ''); $('chartStart').textContent = '00:00'; $('chartEnd').textContent = '00:00'; return; }
  const start = points[0].timestamp_ms, end = Math.max(start + 1, points.at(-1).timestamp_ms);
  const coordinates = points.map(p => [left + (p.timestamp_ms - start) / (end - start) * (right - left), bottom - p.people_count / max * (bottom - top)]);
  if (coordinates.length === 1) coordinates.push([left + 2, coordinates[0][1]]);
  const path = coordinates.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  $('chartLine').setAttribute('d', path); $('chartArea').setAttribute('d', `${path} L${coordinates.at(-1)[0]},${bottom} L${left},${bottom} Z`);
  $('chartStart').textContent = timeLabel(start); $('chartEnd').textContent = timeLabel(end);
}

function callWorker(message, transfer = []) {
  if (message.type === 'init') return runtime.initialize(message);
  return runtime.frame(message, transfer);
}
function terminateWorker() { runtime.close(); }
function closeCamera() { cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; $('cameraVideo').srcObject = null; }
function mediaReady(video, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Không đọc được video. Hãy thử MP4/H.264 hoặc WebM.')), 20000);
    const loaded = () => { if (video.readyState >= 2) finish(); };
    const failed = () => finish(new Error('Trình duyệt không giải mã được video này. Hãy dùng MP4/H.264 hoặc WebM.'));
    function finish(error) { clearTimeout(timeout); video.removeEventListener('loadeddata', loaded); video.removeEventListener('error', failed); error ? reject(error) : resolve(); }
    video.addEventListener('loadeddata', loaded); video.addEventListener('error', failed);
    video.src = url; video.load(); if (video.readyState >= 2) finish();
  });
}
function paint(bitmap, record) {
  const canvas = $('liveCanvas');
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
  const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
  context.lineWidth = 2; context.font = '13px Segoe UI, sans-serif';
  for (const detection of record.detections) {
    const [x1, y1, x2, y2] = detection.bbox_xyxy, tracked = detection.track_id !== null, color = tracked ? '#67d392' : '#efbb59';
    const label = `person ${tracked ? '#' + detection.track_id : 'new'} ${Math.round(detection.confidence * 100)}%`, y = Math.max(22, y1);
    context.strokeStyle = color; context.strokeRect(x1, y1, x2 - x1, y2 - y1); context.fillStyle = color; context.fillRect(x1, y - 22, context.measureText(label).width + 12, 22);
    context.fillStyle = '#14251c'; context.fillText(label, x1 + 6, y - 7);
  }
  context.fillStyle = '#172330df'; context.fillRect(10, 10, 230, 48); context.fillStyle = '#fff';
  context.fillText(`People: ${record.people_count} | Tracks: ${record.tracked_count}`, 20, 30); context.fillText(`Time: ${(record.timestamp_ms / 1000).toFixed(2)}s`, 20, 49);
}
function beginRecording(run) {
  if (!$('recordVideo').checked || !('MediaRecorder' in window) || !$('liveCanvas').captureStream) return;
  try {
    const types = ['video/webm;codecs=vp8', 'video/webm'];
    const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { notice('Trình duyệt chưa hỗ trợ ghi WebM. Dữ liệu CSV/JSONL vẫn được lưu trong phiên.'); return; }
    const stream = $('liveCanvas').captureStream(run.target_fps), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2000000 });
    run.recording = { recorder, stream, chunks, bytes: 0 };
    run.recording.stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.ondataavailable = event => {
      if (event.data.size) { chunks.push(event.data); run.recording.bytes += event.data.size; }
      if (run.recording.bytes > 125 * 1024 * 1024 && recorder.state !== 'inactive') { run.video_partial = true; recorder.stop(); notice('Đã dừng ghi WebM ở giới hạn bộ nhớ 125 MB. Nhận diện và dữ liệu đếm vẫn tiếp tục.'); }
    };
    recorder.onerror = () => { run.video_partial = true; notice('Ghi video bị gián đoạn; dữ liệu đếm vẫn tiếp tục được giữ trong phiên.'); };
    recorder.start(1000);
  } catch { notice('Không ghi được video trên trình duyệt này. Bạn vẫn có thể tải CSV/JSONL.'); }
}
async function endRecording(run) {
  if (!run.recording) return;
  const { recorder, stream, chunks, stopped } = run.recording;
  if (recorder.state !== 'inactive') recorder.stop();
  await Promise.race([stopped, sleep(3000)]); stream.getTracks().forEach(track => track.stop());
  if (chunks.length) run.video_url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  run.recording = null;
}

async function processFrame(run, source) {
  const scale = Math.min(1, 1280 / Math.max(source.videoWidth, source.videoHeight));
  capture.width = Math.max(2, Math.round(source.videoWidth * scale)); capture.height = Math.max(2, Math.round(source.videoHeight * scale));
  captureContext.drawImage(source, 0, 0, capture.width, capture.height);
  const timestamp = run.source_type === 'video' ? source.currentTime * 1000 : performance.now() - run.started;
  const bitmap = await createImageBitmap(capture);
  const result = await callWorker({ type: 'frame', bitmap, timestamp_ms: timestamp, frame_index: run.records.length }, [bitmap]);
  const record = { schema_version: '2.0-browser', session_id: run.id, source_type: run.source_type, ...result.record };
  paint(result.bitmap, record); run.records.push(record); run.latest = record;
  if (!run.timeline.length || timestamp - run.timeline.at(-1).timestamp_ms >= 500) {
    run.timeline.push({ timestamp_ms: timestamp, people_count: record.people_count });
    if (run.timeline.length > 300) run.timeline = run.timeline.filter((_, i) => i % 2 === 0);
  }
  run.fps = run.records.length / Math.max(.001, (performance.now() - run.started) / 1000);
  metrics(record, run.fps); drawChart(run.timeline);
  if (run.source_type === 'video') {
    const percent = Math.min(100, timestamp / run.duration_ms * 100);
    $('progressArea').hidden = false; $('progressBar').value = percent; $('progressValue').textContent = Math.round(percent) + '%';
    $('progressLabel').textContent = `${timeLabel(timestamp)} / ${timeLabel(run.duration_ms)} · ${run.records.length} mẫu đã xử lý`;
  }
  if (run.records.length >= 15000) { run.stop = true; notice('Đã đạt 15.000 mẫu trong phiên để giới hạn bộ nhớ. Hãy tải dữ liệu rồi bắt đầu phiên mới.'); }
}

async function start(demo = false) {
  if (active || (!demo && mode === 'video' && !selectedFile)) return;
  notice(''); $('player').pause(); resetMetrics();
  const run = { id: crypto.randomUUID(), name: demo ? 'Video mẫu · người đi bộ' : mode === 'video' ? selectedFile.name : 'Webcam trình duyệt',
    source_type: demo ? 'video' : mode, created_at: new Date().toISOString(), status: 'loading', confidence: Number($('confidence').value),
    target_fps: Number($('sampleFps').value), records: [], timeline: [], stop: false, provider: null };
  active = run; setBusy(true); badge('loading'); overlay('Đang chuẩn bị nguồn đầu vào…');
  const source = document.createElement('video'); source.muted = true; source.playsInline = true; run.source = source;
  try {
    if (run.source_type === 'webcam') {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Webcam cần HTTPS và trình duyệt có hỗ trợ camera.');
      const device = $('cameraSelect').value;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, ...(device ? { deviceId: { exact: device } } : { facingMode: 'user' }) }, audio: false });
      if (run.stop) { stream.getTracks().forEach(track => track.stop()); return; }
      cameraStream = stream; source.srcObject = stream; await source.play(); await listCameras();
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { run.stop = true; }));
    } else {
      await mediaReady(source, demo ? '/samples/people-walking.mp4' : selectedURL);
      source.addEventListener('error', () => { run.media_error = 'Video bị lỗi giải mã giữa luồng. Hãy thử MP4/H.264 khác.'; run.stop = true; });
      if (!Number.isFinite(source.duration) || source.duration <= 0) throw new Error('Video không có thời lượng hợp lệ. Hãy thử MP4/H.264 khác.');
      run.duration_ms = source.duration * 1000;
    }
    if (run.stop) return;
    overlay('Đang nạp model trên thiết bị…');
    const engine = await callWorker({ type: 'init', confidence: run.confidence, backend: $('backendSelect').value });
    if (run.stop) return;
    run.provider = engine.provider; run.started = performance.now(); run.processing = true;
    $('progressArea').hidden = true;
    $('deviceCaption').textContent = engine.provider === 'webgpu' ? 'GPU của thiết bị · WebGPU' : `CPU của thiết bị · ${engine.threads} luồng WASM`;
    $('modelStatus').textContent = engine.provider === 'webgpu' ? 'GPU · WebGPU đang hoạt động' : 'CPU · WebAssembly đang hoạt động';
    $('sourceLabel').textContent = (run.source_type === 'webcam' ? 'WEBCAM · ' : 'VIDEO · ') + run.name.slice(0, 45);
    overlay(); showMedia('liveCanvas'); run.status = run.source_type === 'webcam' ? 'live' : 'processing'; badge(run.status);
    await processFrame(run, source); beginRecording(run);
    if (run.source_type === 'video' && !run.stop) await source.play();
    let lastCapture = performance.now();
    while (!run.stop && !(run.source_type === 'video' && source.ended)) {
      await sleep(Math.max(0, 1000 / run.target_fps - (performance.now() - lastCapture)));
      if (run.stop || source.ended) break;
      if (source.readyState < 2) continue;
      if (run.source_type === 'video' && source.currentTime * 1000 <= run.latest.timestamp_ms) continue;
      lastCapture = performance.now();
      await processFrame(run, source);
      // Inference is serialized; no frame queue or previous-frame backlog is retained.
    }
    if (run.media_error) throw new Error(run.media_error);
    run.status = run.stop && run.source_type === 'video' ? 'cancelled' : 'completed';
  } catch (error) {
    run.status = run.stop ? 'cancelled' : 'failed'; run.error = error.message;
    const messages = { NotAllowedError: 'Bạn chưa cho phép camera. Mở quyền camera của trang rồi thử lại.', NotFoundError: 'Không tìm thấy camera trên thiết bị.', NotReadableError: 'Không mở được camera. Hãy kiểm tra ứng dụng khác đang dùng camera.' };
    if (!run.stop) notice(messages[error.name] || error.message, 'error');
  } finally {
    source.pause(); source.srcObject = null; source.removeAttribute('src'); source.load(); closeCamera();
    if (run.source_type === 'video' && run.status !== 'completed') run.video_partial = true;
    await endRecording(run);
    if (!['completed', 'cancelled', 'failed'].includes(run.status)) run.status = 'cancelled';
    run.finished_at = new Date().toISOString();
    if (run.latest && run.timeline.at(-1)?.timestamp_ms !== run.latest.timestamp_ms) run.timeline.push({ timestamp_ms: run.latest.timestamp_ms, people_count: run.latest.people_count });
    if (run.records.length) {
      history.unshift(run);
      if (run.latest) {
        const image = await new Promise(resolve => $('liveCanvas').toBlob(resolve, 'image/jpeg', .85));
        if (image) run.preview_url = URL.createObjectURL(image);
      }
      while (history.length > 5) { const removed = history.pop(); if (removed.video_url) URL.revokeObjectURL(removed.video_url); if (removed.preview_url) URL.revokeObjectURL(removed.preview_url); }
      openRun(run.id);
      if (run.status === 'completed') notice(`Hoàn tất ${run.records.length} mẫu trên thiết bị. Kết quả chỉ giữ trong tab này; hãy tải xuống trước khi đóng trang.`, 'success');
    } else { badge(run.status); }
    active = null; setBusy(false); overlay(); $('progressArea').hidden = true; renderHistory();
  }
}
function stop() {
  if (!active) return;
  active.stop = true; active.source?.pause(); closeCamera(); $('stopButton').disabled = true;
  if (!active.processing) terminateWorker();
  notice('Đang dừng và hoàn tất dữ liệu trong phiên…');
}

function revokeDownloads() { downloadUrls.forEach(url => URL.revokeObjectURL(url)); downloadUrls = []; }
function blobLink(id, data, mime, filename) {
  const url = URL.createObjectURL(new Blob([data], { type: mime })); downloadUrls.push(url); $(id).href = url; $(id).download = filename;
}
function openRun(id) {
  const run = history.find(item => item.id === id);
  if (!run || (active && active.id !== id)) { if (active) notice('Hãy dừng phiên hiện tại trước khi xem phiên khác.'); return; }
  metrics(run.latest, run.fps); drawChart(run.timeline); badge(run.status); $('sourceLabel').textContent = run.name.slice(0, 50);
  revokeDownloads(); const prefix = 'peoplelens-' + run.id.slice(0, 8);
  blobLink('downloadCsv', countsCsv(run.records), 'text/csv;charset=utf-8', prefix + '.csv');
  blobLink('downloadJsonl', recordsJsonl(run.records), 'application/x-ndjson', prefix + '.jsonl');
  blobLink('downloadSummary', JSON.stringify(summary(run), null, 2), 'application/json', prefix + '-summary.json');
  $('downloadVideo').hidden = !run.video_url; $('downloadVideo').href = run.video_url || '#'; $('downloadVideo').download = prefix + '.webm';
  $('downloads').hidden = false; $('resultsEmpty').hidden = true;
  if (run.video_url) { $('player').src = run.video_url; showMedia('player'); }
  else if (run.preview_url) { $('preview').src = run.preview_url; showMedia('preview'); }
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function renderHistory() {
  $('historyBody').innerHTML = history.length ? history.map(run => `<tr><td><div class="source-name"><svg><use href="#i-${run.source_type === 'webcam' ? 'camera' : 'video'}"/></svg><span>${escapeHtml(run.name)}</span></div></td><td>${escapeHtml(new Date(run.created_at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }))}</td><td>${run.records.length} mẫu</td><td>${run.latest.peak_count} người</td><td><span class="history-status ${run.status}">${statusNames[run.status]}</span></td><td><button class="history-open" data-run="${run.id}" aria-label="Xem phiên ${escapeHtml(run.name)}">↗</button></td></tr>`).join('') : '<tr><td colspan="6" class="table-empty">Chưa có phiên trong tab này. Thử với video mẫu ở trên.</td></tr>';
}
async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try { const selected = $('cameraSelect').value, devices = await navigator.mediaDevices.enumerateDevices(); $('cameraSelect').replaceChildren(new Option('Camera mặc định', '')); let i = 0; for (const device of devices.filter(d => d.kind === 'videoinput')) $('cameraSelect').add(new Option(device.label || `Camera ${++i}`, device.deviceId)); $('cameraSelect').value = selected; } catch {}
}
function selectFile(file) {
  if (!file || active) return;
  if (!/\.(mp4|webm|mov|m4v)$/i.test(file.name)) { notice('Hãy chọn MP4, WebM hoặc MOV có codec trình duyệt hỗ trợ.', 'error'); return; }
  if (selectedURL) URL.revokeObjectURL(selectedURL);
  selectedFile = file; selectedURL = URL.createObjectURL(file); $('player').src = selectedURL; showMedia('player');
  $('fileName').textContent = file.name; $('fileDetail').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · Chỉ đọc trên thiết bị`;
  $('sourceLabel').textContent = 'VIDEO · ' + file.name.slice(0, 45); resetMetrics(); setMode('video'); badge('Sẵn sàng'); notice('');
}
function clearSession() {
  if (active) return;
  $('player').pause(); $('player').removeAttribute('src'); $('player').load();
  history.forEach(run => { if (run.video_url) URL.revokeObjectURL(run.video_url); if (run.preview_url) URL.revokeObjectURL(run.preview_url); }); history = []; revokeDownloads();
  if (selectedURL) URL.revokeObjectURL(selectedURL); selectedFile = null; selectedURL = null; $('fileInput').value = '';
  $('fileName').textContent = 'Thả video vào đây'; $('fileDetail').textContent = 'hoặc chọn tệp từ máy'; $('sourceLabel').textContent = 'CHƯA CÓ NGUỒN VIDEO';
  const canvas = $('liveCanvas'); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  terminateWorker(); resetMetrics(); showMedia('emptyState'); renderHistory(); setBusy(false); badge('Sẵn sàng'); notice('Đã xóa video và kết quả khỏi phiên này.');
}

async function init() {
  drawChart([]); renderHistory();
  try {
    if (!window.isSecureContext || !window.Worker || !window.OffscreenCanvas || !window.createImageBitmap || !window.WebAssembly) throw new Error('Trang cần HTTPS và trình duyệt có Worker, OffscreenCanvas và WebAssembly. Hãy dùng Chrome hoặc Edge mới.');
    const response = await fetch('/models/manifest.json'); if (!response.ok) throw new Error('Chưa có model trên website.');
    await response.json(); ready = true;
    $('modelStatus').textContent = 'Model có sẵn · tải về khi bắt đầu'; $('deviceCaption').textContent = navigator.gpu ? 'Tự động · ưu tiên WebGPU' : 'CPU · WebAssembly';
    setBusy(false); listCameras();
  } catch (error) { notice(error.message, 'error'); $('modelStatus').textContent = 'Thiết bị chưa sẵn sàng'; }
}
$('videoTab').onclick = () => setMode('video'); $('webcamTab').onclick = () => setMode('webcam');
$('confidence').oninput = () => $('confidenceValue').textContent = Number($('confidence').value).toFixed(2);
for (const id of ['chooseInline', 'dropzone']) $(id).onclick = () => $('fileInput').click();
$('fileInput').onchange = event => selectFile(event.target.files[0]);
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); if (!active) $('dropzone').classList.add('dragover'); });
for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); });
$('dropzone').addEventListener('drop', event => selectFile(event.dataTransfer.files[0]));
$('demoButton').onclick = () => start(true); $('startButton').onclick = () => start(false); $('stopButton').onclick = stop;
$('refreshHistory').onclick = renderHistory; $('clearSession').onclick = clearSession;
$('historyBody').onclick = event => { const button = event.target.closest('[data-run]'); if (button) openRun(button.dataset.run); };
window.addEventListener('pagehide', () => { if (active) active.stop = true; closeCamera(); terminateWorker(); revokeDownloads(); history.forEach(run => { if (run.video_url) URL.revokeObjectURL(run.video_url); if (run.preview_url) URL.revokeObjectURL(run.preview_url); }); if (selectedURL) URL.revokeObjectURL(selectedURL); });
init();
