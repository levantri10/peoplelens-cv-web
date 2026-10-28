export class RuntimeTimeoutError extends Error {
  constructor(message) { super(message); this.name = 'RuntimeTimeoutError'; }
}
const cancelled = () => { const error = new Error('Phiên đã dừng.'); error.name = 'AbortError'; return error; };

/** One request at a time, with an explicit worker handshake and bounded startup stages. */
export class WorkerConnection {
  constructor(createWorker, { onProgress = () => {}, bootTimeoutMs = 10000, requestTimeoutMs = 30000,
    gpuTimeoutMs = 15000, cpuTimeoutMs = 45000 } = {}) {
    this.options = { onProgress, bootTimeoutMs, requestTimeoutMs, gpuTimeoutMs, cpuTimeoutMs };
    this.worker = createWorker(); this.sequence = 0; this.pending = null; this.closed = false;
    this.boot = new Promise((resolve, reject) => { this.resolveBoot = resolve; this.rejectBoot = reject; });
    // Register handlers before sending any requests. The worker must announce its listener is installed.
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.onerror = event => this.fail(new Error(event.message || 'Không khởi động được bộ nhận diện.'));
    this.worker.onmessageerror = () => this.fail(new Error('Không đọc được phản hồi của bộ nhận diện.'));
    this.bootTimer = setTimeout(() => this.fail(new RuntimeTimeoutError('Bộ nhận diện không khởi động sau 10 giây.')), bootTimeoutMs);
  }
  receive(message) {
    if (this.closed) { message.bitmap?.close(); return; }
    if (message.type === 'booted') {
      clearTimeout(this.bootTimer); this.resolveBoot(); return;
    }
    const request = this.pending;
    if (!request || message.id !== request.id) { message.bitmap?.close(); return; }
    if (message.type === 'loading') {
      const timeout = ['gpu-init', 'gpu-warmup'].includes(message.stage) ? this.options.gpuTimeoutMs
        : message.stage === 'cpu-init' ? this.options.cpuTimeoutMs : this.options.requestTimeoutMs;
      this.arm(request, timeout, message.stage);
      this.options.onProgress(message); return;
    }
    clearTimeout(request.timer); this.pending = null;
    if (message.type === 'error') request.reject(new Error(message.message));
    else request.resolve(message);
  }
  arm(request, timeout, stage = request.type) {
    clearTimeout(request.timer);
    request.timer = setTimeout(() => this.fail(new RuntimeTimeoutError(
      `Quá thời gian chờ ở bước ${stage}. Không tiếp tục chờ vô hạn.`)), timeout);
  }
  async request(message, transfer = []) {
    await this.boot;
    if (this.closed) throw cancelled();
    if (this.pending) throw new Error('Bộ nhận diện đang xử lý một khung hình khác.');
    return new Promise((resolve, reject) => {
      const request = { id: ++this.sequence, type: message.type, resolve, reject };
      this.pending = request; this.arm(request, this.options.requestTimeoutMs);
      try { this.worker.postMessage({ ...message, id: request.id }, transfer); }
      catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.bootTimer);
    const request = this.pending; this.pending = null;
    if (request) { clearTimeout(request.timer); request.reject(error); }
    this.rejectBoot(error); this.worker.terminate();
  }
  close() { this.fail(cancelled()); }
}

/** A stalled GPU is discarded before CPU starts, so a half-initialized backend is never reused. */
export class RuntimeClient {
  constructor(createWorker, options = {}) {
    this.createWorker = createWorker; this.options = options;
    this.connection = null; this.preference = null; this.provider = null; this.generation = 0;
  }
  async initialize({ backend = 'auto', confidence = .32 } = {}) {
    const generation = this.generation;
    const reuse = this.connection && !this.connection.closed
      && (this.preference === backend || (backend === 'wasm' && this.provider === 'wasm'));
    const start = async provider => {
      if (generation !== this.generation) throw cancelled();
      if (!reuse || this.provider !== provider) {
        this.connection?.close();
        this.connection = new WorkerConnection(this.createWorker, this.options);
      }
      const result = await this.connection.request({ type: 'init', backend: provider, confidence });
      if (generation !== this.generation) throw cancelled();
      this.preference = backend; this.provider = result.provider; return result;
    };
    if (reuse) return start(this.provider);
    if (backend === 'auto') {
      try { return await start('webgpu'); }
      catch (error) {
        if (error.name === 'AbortError' || generation !== this.generation) throw error;
        this.connection?.close(); this.connection = null; this.provider = null;
        this.options.onProgress?.({ type: 'loading', stage: 'fallback', progress: null,
          message: 'GPU chưa sẵn sàng. Đang khởi động lại bằng CPU…' });
      }
    }
    return start('wasm');
  }
  frame(message, transfer = []) {
    if (!this.connection || !this.provider) return Promise.reject(new Error('Model chưa sẵn sàng.'));
    return this.connection.request(message, transfer);
  }
  close() {
    this.generation++; this.connection?.close(); this.connection = null;
    this.preference = null; this.provider = null;
  }
}
