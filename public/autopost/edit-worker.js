// 動画オート投稿の簡易編集（切り出し・大きさ変更・切り抜き）。
// ffmpeg（WebAssembly 版）をワーカーの中で動かす。動画はこの端末の中だけで処理され、編集のためにどこかへ送られることはない。

let core = null;
let tail = [];

async function load() {
  importScripts("/ffmpeg/ffmpeg-core.js");
  const locate = btoa(JSON.stringify({ wasmURL: "/ffmpeg/ffmpeg-core.wasm", workerURL: "" }));
  core = await self.createFFmpegCore({ mainScriptUrlOrBlob: "/ffmpeg/ffmpeg-core.js#" + locate });
  core.setLogger((entry) => {
    tail.push(String(entry && entry.message));
    if (tail.length > 30) tail.shift();
  });
}

self.onmessage = async ({ data }) => {
  try {
    if (!core) await load();
    // 元の動画はメモリに写さず、ファイルとしてそのまま読ませる（大きい動画でも落ちにくい）
    core.FS.mkdir("/in");
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name: "in", data: data.blob }] }, "/in");
    core.setProgress(({ time }) => {
      // time は出力済みの長さ（マイクロ秒）
      if (data.seconds > 0 && time > 0) self.postMessage({ type: "progress", ratio: Math.min(time / 1e6 / data.seconds, 1) });
    });
    core.setTimeout(-1);
    const code = core.exec(...data.args, "-y", "out.mp4");
    if (code !== 0) throw new Error(tail.slice(-6).join("\n") || "ffmpeg が失敗しました");
    const out = core.FS.readFile("out.mp4");
    self.postMessage({ type: "done", data: out }, [out.buffer]);
  } catch (e) {
    self.postMessage({ type: "error", error: String((e && e.message) || e) });
  }
};
