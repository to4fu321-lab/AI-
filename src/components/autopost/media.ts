// ブラウザの中で動画を調べる・コマを抜く・編集する。

export interface Meta {
  duration: number;
  width: number;
  height: number;
}

export type Aspect = "original" | "9:16" | "1:1" | "4:5" | "16:9";

export interface EditSpec {
  /** 切り出す範囲（秒） */
  start: number;
  end: number;
  aspect: Aspect;
  /** 形を変えるとき：crop=はみ出しを切り落とす / pad=黒い余白を足す */
  fit: "crop" | "pad";
  /** 短い辺の上限（0 は元のまま）。1080 なら フル HD まで */
  maxSide: number;
  mute: boolean;
}

export const ASPECTS: { value: Aspect; label: string }[] = [
  { value: "original", label: "元のまま" },
  { value: "9:16", label: "縦長 9:16（ショート・リール）" },
  { value: "1:1", label: "正方形 1:1" },
  { value: "4:5", label: "縦 4:5（Instagram）" },
  { value: "16:9", label: "横長 16:9（YouTube）" },
];

export function aspectRatio(aspect: Aspect, meta: Meta): number {
  if (aspect === "original") return meta.width / meta.height;
  const [w, h] = aspect.split(":").map(Number);
  return w / h;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** 編集しても何も変わらないか */
export function isNoop(spec: EditSpec, meta: Meta): boolean {
  const { video } = plan(spec, meta);
  return spec.start <= 0.05 && spec.end >= meta.duration - 0.05 && !video && !spec.mute;
}

function plan(spec: EditSpec, meta: Meta): { video: string | null; seconds: number } {
  const seconds = Math.max(0.1, Math.min(spec.end, meta.duration) - Math.max(spec.start, 0));
  const filters: string[] = [];
  let w = meta.width;
  let h = meta.height;
  const target = aspectRatio(spec.aspect, meta);
  if (spec.aspect !== "original" && Math.abs(w / h - target) > 0.01) {
    if (spec.fit === "crop") {
      const cw = even(Math.min(w, h * target));
      const ch = even(Math.min(h, w / target));
      filters.push(`crop=${cw}:${ch}:${Math.floor((w - cw) / 2)}:${Math.floor((h - ch) / 2)}`);
      [w, h] = [cw, ch];
    } else {
      const pw = even(Math.max(w, h * target));
      const ph = even(Math.max(h, w / target));
      filters.push(`pad=${pw}:${ph}:${Math.floor((pw - w) / 2)}:${Math.floor((ph - h) / 2)}:black`);
      [w, h] = [pw, ph];
    }
  }
  const short = Math.min(w, h);
  if (spec.maxSide > 0 && short > spec.maxSide) {
    const k = spec.maxSide / short;
    filters.push(`scale=${even(w * k)}:${even(h * k)}`);
  } else if (filters.length && (w % 2 || h % 2)) {
    filters.push(`scale=${even(w)}:${even(h)}`);
  }
  return { video: filters.length ? filters.join(",") : null, seconds };
}

/** ffmpeg に渡す指示。絵を変えないときは作り直さずに写すだけ（速く、画質も落ちない） */
export function buildArgs(spec: EditSpec, meta: Meta): { args: string[]; seconds: number } {
  const { video, seconds } = plan(spec, meta);
  const args = ["-ss", spec.start.toFixed(3), "-i", "/in/in", "-t", seconds.toFixed(3)];
  if (video) args.push("-vf", video, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  if (spec.mute) args.push("-an");
  else if (video) args.push("-c:a", "aac", "-b:a", "128k");
  else args.push("-c:a", "copy");
  args.push("-movflags", "+faststart", "-f", "mp4");
  return { args, seconds };
}

export function runEdit(blob: Blob, spec: EditSpec, meta: Meta, onProgress: (ratio: number) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/autopost/edit-worker.js");
    const finish = (fn: () => void) => {
      worker.terminate();
      fn();
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress(data.ratio);
      else if (data.type === "done") finish(() => resolve(new Blob([data.data], { type: "video/mp4" })));
      else finish(() => reject(new Error(`編集に失敗しました：${data.error}`)));
    };
    worker.onerror = (e) => finish(() => reject(new Error(`編集に失敗しました：${e.message || "メモリが足りない可能性があります"}`)));
    worker.postMessage({ blob, ...buildArgs(spec, meta) });
  });
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => reject(new Error("この動画はブラウザで開けません（MP4・MOV・WebM をお使いください）"));
    v.src = src;
  });
}

function seek(v: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000);
    v.onseeked = () => {
      clearTimeout(timer);
      resolve();
    };
    v.currentTime = time;
  });
}

function draw(v: HTMLVideoElement, maxSide: number, quality: number): string {
  const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(v.videoWidth * k));
  canvas.height = Math.max(1, Math.round(v.videoHeight * k));
  canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** 動画の長さ・大きさと、一覧用の絵、AI に見せるコマ（時間順に数枚）を取り出す */
export async function inspect(blob: Blob, frameCount = 6): Promise<Meta & { thumb: string; frames: string[] }> {
  const url = URL.createObjectURL(blob);
  try {
    const v = await loadVideo(url);
    // 録画したての WebM などは長さが分からないことがある
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const frames: string[] = [];
    let thumb = "";
    for (let i = 0; i < frameCount; i++) {
      await seek(v, duration * ((i + 0.5) / frameCount));
      frames.push(draw(v, 512, 0.7));
      if (i === 0) thumb = draw(v, 320, 0.6);
    }
    return { duration, width: v.videoWidth, height: v.videoHeight, thumb, frames };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`;
}
