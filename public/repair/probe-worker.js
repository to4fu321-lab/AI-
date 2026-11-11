// Trial decoder for the video repair page.
//
// Runs ffmpeg (WebAssembly) in a worker: the page sends a few H.264 frames with a candidate
// SPS/PPS and gets back the decoded picture plus whether the decoder complained. Nothing leaves
// the device.

let core = null;
let logs = [];

async function load() {
  importScripts("/ffmpeg/ffmpeg-core.js");
  const locate = btoa(JSON.stringify({ wasmURL: "/ffmpeg/ffmpeg-core.wasm", workerURL: "" }));
  core = await self.createFFmpegCore({ mainScriptUrlOrBlob: "/ffmpeg/ffmpeg-core.js#" + locate });
  core.setLogger((entry) => logs.push(String(entry && entry.message)));
}

function remove(path) {
  try {
    core.FS.unlink(path);
  } catch {
    // not there
  }
}

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (!core) await load();
    if (data.type === "load") {
      self.postMessage({ id, ok: true });
      return;
    }

    logs = [];
    remove("out.raw");
    const input = data.codec === "hevc" ? "in.hevc" : "in.h264";
    core.FS.writeFile(input, data.stream);
    core.setTimeout(-1);
    // -ec 0: no error concealment, so anything that failed to decode stays visibly empty.
    // Only the requested frame is written out, so memory use does not grow with the frame count.
    core.exec(
      "-v", "error", "-threads", "1", "-ec", "0", "-i", input,
      "-vf", "select=gte(n\\," + data.frame + ")", "-frames:v", "1",
      "-pix_fmt", "yuv420p", "-f", "rawvideo", "-y", "out.raw",
    );
    core.reset();

    let frame = null;
    try {
      const all = core.FS.readFile("out.raw");
      const size = data.width * data.height * 1.5;
      if (all.length >= size) frame = all.slice(0, size);
    } catch {
      // the decoder produced nothing
    }
    remove("out.raw");
    remove(input);

    const errors = logs.some((l) => /\[(h264|hevc) @|rror|nvalid/.test(l) && !l.includes("co located POCs unavailable"));
    if (frame) self.postMessage({ id, ok: true, frame, errors }, [frame.buffer]);
    else self.postMessage({ id, ok: true, frame: null, errors: true });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e) });
  }
};
