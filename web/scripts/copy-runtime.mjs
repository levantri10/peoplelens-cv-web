import { mkdir, readdir, copyFile, unlink, stat, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, 'node_modules/onnxruntime-web/dist');
const target = path.join(root, 'web/public/ort');
await mkdir(target, { recursive: true });
const files = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm',
  'ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
for (const entry of await readdir(target, { withFileTypes: true })) if (entry.isFile() && !files.includes(entry.name)) await unlink(path.join(target, entry.name));
for (const name of files) await copyFile(path.join(source, name), path.join(target, name));
const version = JSON.parse(await readFile(path.join(root, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version;
const manifest = { version, files: Object.fromEntries(await Promise.all(files.map(async name => [name, { bytes: (await stat(path.join(source, name))).size }]))) };
await writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('ONNX Runtime WASM files prepared.');
