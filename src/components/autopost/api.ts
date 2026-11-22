/** 動画オート投稿の API を呼ぶ（失敗したら、画面に出せる日本語の理由つきで投げる） */
export async function api<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`/api/autopost/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `うまくいきませんでした（${res.status}）`);
  return json as T;
}

/** 動画を置き場へ直接アップロードする（サーバーを経由しないので、大きい動画も送れる） */
export function upload(url: string, blob: Blob, onProgress: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", blob);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-upsert", "true");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const tooBig = xhr.status === 413 || /exceeded|too large/i.test(xhr.responseText);
      reject(new Error(tooBig ? "動画が大きすぎて置き場に入りません（Supabase の 1 ファイルの上限を超えています。編集で小さくするか、上限を上げてください）" : `アップロードに失敗しました（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error("アップロードが途中で切れました。電波のよい所でもう一度お試しください"));
    xhr.send(form);
  });
}

export const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-[16px] outline-none focus:border-fuchsia-400 dark:border-neutral-700 dark:bg-neutral-900";
export const card = "rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900";
export const primary = "rounded-full bg-fuchsia-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40";
export const ghost = "rounded-full bg-neutral-200/80 px-4 py-2.5 text-sm font-semibold text-neutral-700 disabled:opacity-40 dark:bg-neutral-800 dark:text-neutral-200";
