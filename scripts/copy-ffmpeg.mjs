// Copies the ffmpeg WebAssembly build into public/ so the repair page can load it from the
// same origin. Runs before `next dev` and `next build`; the copies are not committed.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@ffmpeg", "core", "dist", "umd");
const to = join(root, "public", "ffmpeg");

mkdirSync(to, { recursive: true });
for (const name of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  const src = join(from, name);
  const dst = join(to, name);
  if (!existsSync(src)) {
    console.error(`copy-ffmpeg: ${src} is missing — run npm install`);
    process.exit(1);
  }
  if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
}
