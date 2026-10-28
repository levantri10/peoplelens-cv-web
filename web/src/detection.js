import { iou } from './tracking.js';

export function decodeYolo(output, { width, height, scale, padX, padY }, threshold = .1, nmsThreshold = .7) {
  const count = output.dims[2];
  if (output.dims.length !== 3 || output.dims[0] !== 1 || output.dims[1] !== 5) throw new Error('Model không có đầu ra person [1,5,N] như yêu cầu.');
  const values = output.data, candidates = [];
  for (let i = 0; i < count; i++) {
    const confidence = values[4 * count + i];
    if (!Number.isFinite(confidence) || confidence < threshold) continue;
    const x = values[i], y = values[count + i], w = values[2 * count + i], h = values[3 * count + i];
    const box = [Math.max(0, (x - w / 2 - padX) / scale), Math.max(0, (y - h / 2 - padY) / scale),
      Math.min(width, (x + w / 2 - padX) / scale), Math.min(height, (y + h / 2 - padY) / scale)];
    if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) continue;
    candidates.push({ confidence, bbox_xyxy: box, class_id: 0, label: 'person', track_id: null });
  }
  candidates.sort((a, b) => b.confidence - a.confidence);
  const selected = [];
  for (const candidate of candidates.slice(0, 3000)) {
    if (selected.every(other => iou(candidate.bbox_xyxy, other.bbox_xyxy) <= nmsThreshold)) selected.push(candidate);
    if (selected.length === 300) break;
  }
  return selected;
}

export function letterboxGeometry(width, height, size = 640) {
  const scale = Math.min(size / width, size / height);
  const resizedWidth = Math.round(width * scale), resizedHeight = Math.round(height * scale);
  return { width, height, scale, resizedWidth, resizedHeight,
    padX: Math.round((size - resizedWidth) / 2 - .1), padY: Math.round((size - resizedHeight) / 2 - .1) };
}

export function rgbaToTensor(data, size = 640) {
  const plane = size * size, output = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) { output[i] = data[i * 4] / 255; output[plane + i] = data[i * 4 + 1] / 255; output[plane * 2 + i] = data[i * 4 + 2] / 255; }
  return output;
}
