import { mkdir, readdir, copyFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'node_modules/onnxruntime-web/dist');
const target = path.join(root, 'web/public/ort');
await mkdir(target, { recursive: true });
const files = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
for (const entry of await readdir(target, { withFileTypes: true })) if (entry.isFile() && !files.includes(entry.name)) await unlink(path.join(target, entry.name));
for (const name of files) await copyFile(path.join(source, name), path.join(target, name));
console.log('ONNX Runtime WASM files prepared.');
