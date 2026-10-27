// Loads the browser modules (parse-core, zip-driver, fflate) into a Node vm context, exactly as the worker would.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/js');
export function load() {
  const ctx = { TextDecoder, TextEncoder, console, Uint8Array, performance, setTimeout };
  ctx.self = ctx; vm.createContext(ctx);
  for (const f of ['vendor/fflate.js', 'parse-core.js', 'zip-driver.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
export function fileSrc(file) {
  const fd = fs.openSync(file, 'r'), size = fs.statSync(file).size;
  return { size, name: path.basename(file), read: async (a, b) => { const buf = Buffer.alloc(b - a); fs.readSync(fd, buf, 0, b - a, a); return new Uint8Array(buf.buffer, buf.byteOffset, buf.length); } };
}
