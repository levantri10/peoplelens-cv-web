/** Browser ByteTrack: Kalman XYAH prediction, global IoU assignment and two score stages.
 * Algorithm: Yifu Zhang et al., ByteTrack (ECCV 2022), https://github.com/ifzhang/ByteTrack
 * Independently expressed JavaScript implementation; upstream MIT notice is in THIRD_PARTY_NOTICES.md.
 */

export function iou(a, b) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const union = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1])
    + Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) - intersection;
  return union > 0 ? intersection / union : 0;
}

// Minimum-cost rectangular assignment. Dummy columns let every row remain unmatched.
export function assign(costs, limit) {
  const rows = costs.length, columns = costs[0]?.length || 0;
  if (!rows || !columns) return { matches: [], unmatchedRows: Array.from({ length: rows }, (_, i) => i), unmatchedColumns: Array.from({ length: columns }, (_, i) => i) };
  const count = columns + rows;
  const u = new Float64Array(rows + 1), v = new Float64Array(count + 1);
  const p = new Int32Array(count + 1), way = new Int32Array(count + 1);
  for (let row = 1; row <= rows; row++) {
    p[0] = row;
    let column = 0;
    const minimum = new Float64Array(count + 1).fill(Infinity);
    const used = new Uint8Array(count + 1);
    do {
      used[column] = 1;
      const currentRow = p[column];
      let delta = Infinity, nextColumn = 0;
      for (let candidate = 1; candidate <= count; candidate++) {
        if (used[candidate]) continue;
        const raw = candidate <= columns ? costs[currentRow - 1][candidate - 1] : limit + 1e-6;
        const value = (raw <= limit ? raw : candidate > columns ? raw : limit + 1) - u[currentRow] - v[candidate];
        if (value < minimum[candidate]) { minimum[candidate] = value; way[candidate] = column; }
        if (minimum[candidate] < delta) { delta = minimum[candidate]; nextColumn = candidate; }
      }
      for (let candidate = 0; candidate <= count; candidate++) {
        if (used[candidate]) { u[p[candidate]] += delta; v[candidate] -= delta; }
        else minimum[candidate] -= delta;
      }
      column = nextColumn;
    } while (p[column] !== 0);
    do { const previous = way[column]; p[column] = p[previous]; column = previous; } while (column !== 0);
  }
  const matches = [];
  for (let column = 1; column <= columns; column++) if (p[column] && costs[p[column] - 1][column - 1] <= limit) matches.push([p[column] - 1, column - 1]);
  const matchedRows = new Set(matches.map(pair => pair[0])), matchedColumns = new Set(matches.map(pair => pair[1]));
  return { matches, unmatchedRows: Array.from({ length: rows }, (_, i) => i).filter(i => !matchedRows.has(i)), unmatchedColumns: Array.from({ length: columns }, (_, i) => i).filter(i => !matchedColumns.has(i)) };
}

const matrix = (rows, columns) => Array.from({ length: rows }, () => new Float64Array(columns));
const measurement = box => { const h = Math.max(1, box[3] - box[1]); return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, Math.max(1, box[2] - box[0]) / h, h]; };

function inverse4(input) {
  const augmented = input.map((row, i) => [...row, ...Array.from({ length: 4 }, (_, j) => +(i === j))]);
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const scale = Math.abs(augmented[column][column]) < 1e-12 ? 1e-12 : augmented[column][column];
    for (let j = 0; j < 8; j++) augmented[column][j] /= scale;
    for (let row = 0; row < 4; row++) if (row !== column) {
      const factor = augmented[row][column];
      for (let j = 0; j < 8; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map(row => row.slice(4));
}

class KalmanTrack {
  constructor(detection, id, frame, timestamp) {
    const z = measurement(detection.bbox_xyxy), h = z[3];
    this.mean = Float64Array.from([...z, 0, 0, 0, 0]);
    const deviation = [h / 10, h / 10, .01, h / 10, h / 16, h / 16, 1e-5, h / 16];
    this.covariance = matrix(8, 8);
    for (let i = 0; i < 8; i++) this.covariance[i][i] = deviation[i] ** 2;
    this.id = id; this.start = frame; this.lastFrame = frame; this.lastSeen = timestamp;
    this.confirmed = frame === 1; this.state = 'tracked';
  }
  get box() {
    const [x, y, a, rawHeight] = this.mean, h = Math.max(1, rawHeight), w = Math.max(1, a * h);
    return [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
  }
  predict() {
    if (this.state === 'lost') this.mean[7] = 0;
    const h = Math.max(1, this.mean[3]);
    const noise = [h / 20, h / 20, .01, h / 20, h / 160, h / 160, 1e-5, h / 160];
    const previous = this.covariance, next = matrix(8, 8);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      next[i][j] = previous[i][j] + (i < 4 ? previous[i + 4][j] : 0)
        + (j < 4 ? previous[i][j + 4] : 0) + (i < 4 && j < 4 ? previous[i + 4][j + 4] : 0);
    }
    for (let i = 0; i < 8; i++) next[i][i] += noise[i] ** 2;
    for (let i = 0; i < 4; i++) this.mean[i] += this.mean[i + 4];
    this.covariance = next;
  }
  update(detection, frame, timestamp) {
    const z = measurement(detection.bbox_xyxy), h = Math.max(1, this.mean[3]);
    const noise = [h / 20, h / 20, .1, h / 20];
    const projected = matrix(4, 4), gain = matrix(8, 4);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) projected[i][j] = this.covariance[i][j] + (i === j ? noise[i] ** 2 : 0);
    const inverse = inverse4(projected);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) gain[i][j] += this.covariance[i][k] * inverse[k][j];
    const innovation = z.map((value, index) => value - this.mean[index]);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) this.mean[i] += gain[i][j] * innovation[j];
    const next = matrix(8, 8);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      let reduction = 0;
      for (let k = 0; k < 4; k++) reduction += gain[i][k] * this.covariance[k][j];
      next[i][j] = this.covariance[i][j] - reduction;
    }
    this.covariance = next; this.mean[2] = Math.max(.001, this.mean[2]); this.mean[3] = Math.max(1, this.mean[3]);
    this.confirmed = true; this.state = 'tracked'; this.lastFrame = frame; this.lastSeen = timestamp;
  }
}

export class ByteTracker {
  constructor({ highThreshold = .25, lowThreshold = .1, lostBufferMs = 1500 } = {}) {
    this.high = highThreshold; this.low = lowThreshold; this.buffer = lostBufferMs;
    this.tracks = []; this.nextId = 1; this.frame = 0;
  }
  update(detections, timestampMs) {
    this.frame++;
    this.tracks = this.tracks.filter(track => track.state !== 'removed' && timestampMs - track.lastSeen <= this.buffer);
    const high = [], low = [];
    detections.forEach((detection, index) => {
      detection.track_id = null;
      if (detection.confidence >= this.high) high.push(index);
      else if (detection.confidence >= this.low) low.push(index);
    });
    const pool = this.tracks.filter(track => track.confirmed);
    const unconfirmed = this.tracks.filter(track => !track.confirmed);
    pool.forEach(track => track.predict());
    const associate = (tracks, indices, threshold, fuse) => {
      if (!tracks.length || !indices.length) return { tracks, indices };
      const costs = tracks.map(track => indices.map(index => 1 - iou(track.box, detections[index].bbox_xyxy) * (fuse ? detections[index].confidence : 1)));
      const assignment = assign(costs, threshold);
      for (const [row, column] of assignment.matches) {
        const track = tracks[row], detection = detections[indices[column]];
        track.update(detection, this.frame, timestampMs);
        detection.track_id = track.id;
      }
      return { tracks: assignment.unmatchedRows.map(i => tracks[i]), indices: assignment.unmatchedColumns.map(i => indices[i]) };
    };
    const first = associate(pool, high, .8, true);
    const second = associate(first.tracks.filter(track => track.state === 'tracked'), low, .5, false);
    second.tracks.forEach(track => { track.state = 'lost'; });
    const third = associate(unconfirmed, first.indices, .7, true);
    third.tracks.forEach(track => { track.state = 'removed'; });
    for (const index of third.indices) {
      const track = new KalmanTrack(detections[index], this.nextId++, this.frame, timestampMs);
      this.tracks.push(track);
      if (track.confirmed) detections[index].track_id = track.id;
    }
    // Retire duplicate lost tracks that overlap a longer-lived active track.
    const active = this.tracks.filter(track => track.state === 'tracked' && track.confirmed);
    for (const lost of this.tracks.filter(track => track.state === 'lost')) {
      if (active.some(track => iou(track.box, lost.box) > .85 && track.start <= lost.start)) lost.state = 'removed';
    }
    this.tracks = this.tracks.filter(track => track.state !== 'removed');
    return detections;
  }
}
