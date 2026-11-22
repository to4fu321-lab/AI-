/**
 * ファイル保存サービス（Google ドライブ・Dropbox・OneDrive など）の「共有リンク」を、
 * ファイルそのものの URL（直リンク）に変える。
 *
 * 共有リンクを開くと、そのサービスの「プレビュー画面」（HTML）が出るだけで、
 * 画面の中の動画は JavaScript で後から出したり、ダウンロードボタンの先にあったりする。
 * ところが多くのサービスには「ファイルそのものを返す決まった URL の形」があるので、
 * 共有リンクを見つけたら、ページを開かずにその形へ書き換える。
 *
 * 書き換えた URL は「動画かもしれない」候補として出し、本当に動画か（中身の先頭のバイト）は後で確かめる。
 * MEGA のように中身が暗号化されているサービスは、ブラウザの中で鍵を使って戻すしかないので対象外。
 */

export interface HostedFile {
  /** ファイルそのものの URL */
  src: string;
  /** サービスの名前（一覧の形式の欄に出す） */
  service: string;
  thumb?: string;
  /** 共有リンクの URL に動画の拡張子が見えていたか（見えていなければ、中身で確かめるまで動画かわからない） */
  sure: boolean;
}

const VIDEO_NAME_RE = /\.(?:mp4|m4v|mov|webm|mkv|avi|wmv|flv|ts|m3u8|3gp|mpg|mpeg|ogv)(?:$|[?#/])/i;

/** URL を base64url にする（OneDrive の共有 API の決まり） */
function base64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function hostedFile(raw: string): HostedFile | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname;
  const sure = VIDEO_NAME_RE.test(decodeURIComponent(path));
  let m: RegExpExecArray | null;

  // --- Google ドライブ：/file/d/ID/view・/open?id=ID・/uc?id=ID ---
  if (host === "drive.google.com" || host === "docs.google.com" || host === "drive.usercontent.google.com") {
    const id =
      /\/file\/d\/([\w-]{20,})/.exec(path)?.[1] ??
      (/^\/(?:open|uc|download)$/.test(path) ? u.searchParams.get("id") : null);
    if (id && /^[\w-]{20,}$/.test(id)) {
      return {
        // confirm=t で「大きいファイルはウイルス検査できません」の確認画面を飛ばす
        src: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
        service: "Google ドライブ",
        thumb: `https://drive.google.com/thumbnail?id=${id}&sz=w640`,
        sure: false,
      };
    }
    return null;
  }

  // --- Dropbox：/s/…・/scl/fi/…（dl=0 を dl=1 にすると、ファイルそのものが返る）---
  if ((host === "dropbox.com" || host === "dl.dropbox.com") && /^\/(?:s|scl\/fi)\//.test(path)) {
    const out = new URL(`https://www.dropbox.com${path}`);
    const rlkey = u.searchParams.get("rlkey");
    if (rlkey) out.searchParams.set("rlkey", rlkey);
    out.searchParams.set("dl", "1");
    return { src: out.toString(), service: "Dropbox", sure };
  }

  // --- OneDrive（個人用）：1drv.ms の短縮リンク・onedrive.live.com の共有リンク ---
  // 共有リンクを base64url にして「shares/u!…/root/content」に渡すと、ファイルそのものが返る
  if (host === "1drv.ms" || (host === "onedrive.live.com" && (u.searchParams.has("resid") || u.searchParams.has("cid") || /\/redir|\/embed/.test(path)))) {
    return { src: `https://api.onedrive.com/v1.0/shares/u!${base64Url(raw)}/root/content`, service: "OneDrive", sure };
  }

  // --- SharePoint・OneDrive（仕事用）：/:v:/…（動画）・/:u:/…（ファイル）に download=1 ---
  if (/\.sharepoint\.com$/.test(host) && (m = /^\/:([vu]):\//.exec(path))) {
    const out = new URL(u.toString());
    out.searchParams.set("download", "1");
    return { src: out.toString(), service: "OneDrive", sure: sure || m[1] === "v" };
  }

  // --- pixeldrain：/u/ID → /api/file/ID ---
  if (host === "pixeldrain.com" && (m = /^\/(?:u|api\/file)\/([\w]{6,})/.exec(path))) {
    return {
      src: `https://pixeldrain.com/api/file/${m[1]}`,
      service: "pixeldrain",
      thumb: `https://pixeldrain.com/api/file/${m[1]}/thumbnail`,
      sure: false,
    };
  }

  // --- Box：/s/ID → shared/static/ID（公開リンクのみ）---
  if ((host === "app.box.com" || /\.app\.box\.com$/.test(host)) && (m = /^\/s\/([a-z0-9]{20,})/i.exec(path))) {
    return { src: `https://${u.hostname}/shared/static/${m[1]}`, service: "Box", sure };
  }

  // --- Imgur の .gifv は、中身が MP4 ---
  if (host === "i.imgur.com" && /\.gifv$/i.test(path)) {
    return { src: `https://i.imgur.com${path.replace(/\.gifv$/i, ".mp4")}`, service: "Imgur", sure: true };
  }

  return null;
}

/**
 * ファイル保存サービスの「フォルダ」の共有リンクを、中のファイルの一覧が HTML で読めるページに変える（なければ null）。
 * Google ドライブのフォルダは、そのままだと JavaScript で一覧を出すが、埋め込み用の一覧ページは HTML に書いてある
 */
export function folderListPage(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (host === "drive.google.com") {
      const id = /\/drive\/(?:u\/\d+\/)?folders\/([\w-]{20,})/.exec(u.pathname)?.[1];
      if (id) return `https://drive.google.com/embeddedfolderview?id=${id}#list`;
    }
  } catch {
    /* ignore */
  }
  return null;
}
