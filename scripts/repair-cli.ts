// Command-line harness for the repair engine (used for testing with the system ffmpeg):
//   npx tsx scripts/repair-cli.ts <broken> <output.mp4> [reference]
import { spawnSync } from "node:child_process";
import { mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairVideo, type Prober } from "../src/lib/repair";

const [input, output, reference] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: repair-cli <broken> <output.mp4> [reference]");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "repair-"));
let probes = 0;
const prober: Prober = {
  async decodeYuv(annexB, width, height, frame) {
    probes++;
    const src = join(dir, "in.h264");
    const dst = join(dir, "out.raw");
    writeFileSync(src, annexB);
    rmSync(dst, { force: true });
    try {
      const args = ["-v", "error", "-ec", "0", "-i", src, "-vf", `select=gte(n\\,${frame})`, "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-y", dst];
      const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
      const errors = run.stderr.split("\n").some((l) => l.trim() && !l.includes("co located POCs unavailable"));
      const all = new Uint8Array(readFileSync(dst));
      const size = width * height * 1.5;
      return all.length >= size ? { data: all.subarray(0, size), errors } : null;
    } catch {
      return null;
    }
  },
};

async function main() {
  const t0 = Date.now();
  let last = "";
  const result = await repairVideo(await openAsBlob(input), {
    reference: reference ? await openAsBlob(reference) : null,
    prober: async () => prober,
    onProgress: (stage) => {
      if (stage !== last) console.error(`[${stage}]`);
      last = stage;
    },
  });
  writeFileSync(output, new Uint8Array(await result.blob.arrayBuffer()));
  const { blob: _blob, ...info } = result;
  void _blob;
  console.log(JSON.stringify({ ...info, probes, ms: Date.now() - t0 }, null, 2));
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => rmSync(dir, { recursive: true, force: true }));
