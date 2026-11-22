import { guardApi } from "@/lib/access/locks";
import { encryptJson, hashPassword, hasSecret } from "@/lib/autopost/crypto";
import { BUCKET, credsOf, db, getSiteRow, getVideo, MEMBER_COLUMNS, must, signedUrl, toSite, UserError, VIDEO_COLUMNS, type SiteRow } from "@/lib/autopost/db";
import { generateDrafts, hasAi } from "@/lib/autopost/generate";
import { publishExternal } from "@/lib/autopost/publish";
import { applyRules, defaultRules, KINDS, type AppState, type Member, type Post, type SiteKind, type SiteRules, type Video } from "@/lib/autopost/types";

export const runtime = "nodejs";
// 投稿は動画を相手のサイトへ送り終えるまで待つので長めに
export const maxDuration = 300;

type Body = Record<string, unknown>;

const str = (v: unknown, max = 20000) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isImage = (v: unknown): v is string => typeof v === "string" && v.startsWith("data:image/") && v.length < 400_000;

function videoFields(b: Body) {
  const out: Record<string, unknown> = {};
  if (typeof b.name === "string") out.name = str(b.name, 200) || "動画";
  if (typeof b.memo === "string") out.memo = str(b.memo, 4000);
  if (isImage(b.thumb)) out.thumb = b.thumb;
  if (Array.isArray(b.frames)) out.frames = b.frames.filter(isImage).slice(0, 8);
  for (const k of ["duration", "width", "height", "size"] as const) if (typeof b[k] === "number") out[k] = k === "duration" ? num(b[k]) : Math.round(num(b[k]));
  return out;
}

function cleanRules(kind: SiteKind, input: unknown): SiteRules {
  const r = (input ?? {}) as Partial<Record<keyof SiteRules, unknown>>;
  const base = defaultRules(kind);
  const limit = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? Math.min(Math.round(v), 10000) : fallback);
  return {
    required: str(r.required, 1000),
    hashtags: str(r.hashtags, 500),
    tone: str(r.tone, 1000),
    titleMax: limit(r.titleMax, base.titleMax),
    bodyMax: limit(r.bodyMax, base.bodyMax),
    privacy: r.privacy === "public" || r.privacy === "unlisted" ? r.privacy : "private",
    postUrl: /^https?:\/\//.test(str(r.postUrl)) ? str(r.postUrl, 500) : "",
  };
}

async function newUpload(videoId: string, fileName: string) {
  const ext = (/\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1] ?? "mp4").toLowerCase();
  const path = `videos/${videoId}/${Date.now()}.${ext}`;
  const { data, error } = await db().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new UserError(`アップロードの準備に失敗しました：${error?.message ?? ""}（Supabase に「autopost」の置き場があるか確かめてください）`);
  return { path, url: data.signedUrl };
}

const ACTIONS: Record<string, (b: Body, request: Request) => Promise<unknown>> = {
  /** 画面に出すもの一式 */
  async state(): Promise<AppState> {
    const setup = { db: true, secret: hasSecret(), ai: hasAi() };
    const empty = { videos: [], sites: [], posts: [], members: [] };
    try {
      const c = db();
      const [videos, sites, posts, members] = await Promise.all([
        c.from("autopost_videos").select(VIDEO_COLUMNS).order("created_at", { ascending: false }),
        c.from("autopost_sites").select("*").order("created_at"),
        c.from("autopost_posts").select("*").order("created_at"),
        c.from("autopost_members").select(MEMBER_COLUMNS).order("created_at"),
      ]);
      return {
        setup,
        videos: must(videos) as Video[],
        sites: (must(sites) as SiteRow[]).map(toSite),
        posts: must(posts) as Post[],
        members: must(members) as Member[],
      };
    } catch (e) {
      // 設定がまだのときも画面は開けるようにして、何が足りないかを見せる
      if (e instanceof UserError) return { setup: { ...setup, db: false }, ...empty };
      throw e;
    }
  },

  // ---- 動画 ----
  async videoCreate(b) {
    const video = must(await db().from("autopost_videos").insert(videoFields({ name: "動画", ...b })).select(VIDEO_COLUMNS).single()) as Video;
    return { video, upload: await newUpload(video.id, video.name) };
  },
  /** 編集した動画で差し替えるときのアップロード先 */
  async videoUploadUrl(b) {
    const video = await getVideo(str(b.id));
    return { upload: await newUpload(video.id, "edited.mp4") };
  },
  async videoUpdate(b) {
    const video = await getVideo(str(b.id));
    const fields = videoFields(b);
    const path = str(b.path, 300);
    if (path) {
      if (!path.startsWith(`videos/${video.id}/`)) throw new UserError("動画の場所が正しくありません");
      fields.path = path;
    }
    const updated = must(await db().from("autopost_videos").update(fields).eq("id", video.id).select(VIDEO_COLUMNS).single()) as Video;
    // 差し替えたら古いファイルは消す
    if (path && video.path && video.path !== path) await db().storage.from(BUCKET).remove([video.path]);
    return { video: updated };
  },
  async videoDelete(b) {
    const video = await getVideo(str(b.id));
    if (video.path) await db().storage.from(BUCKET).remove([video.path]);
    must(await db().from("autopost_videos").delete().eq("id", video.id));
    return { ok: true };
  },
  async videoUrl(b) {
    const video = await getVideo(str(b.id));
    return { url: await signedUrl(video.path) };
  },

  // ---- 投稿先 ----
  async siteSave(b) {
    const id = str(b.id);
    const existing = id ? await getSiteRow(id) : null;
    const kind = (existing?.kind ?? str(b.kind)) as SiteKind;
    if (!(kind in KINDS)) throw new UserError("投稿先の種類が正しくありません");
    const fields: Record<string, unknown> = {
      kind,
      name: str(b.name, 100).trim() || KINDS[kind].label,
      enabled: b.enabled !== false,
      auto: b.auto !== false,
      rules: cleanRules(kind, b.rules),
    };
    // 鍵は「入力があった項目だけ」上書きする（空欄は保存済みのまま）
    const input = (b.creds ?? {}) as Record<string, unknown>;
    const entered = KINDS[kind].creds.map((f) => [f.key, str(input[f.key], 4000).trim()] as const).filter(([, v]) => v);
    if (entered.length) {
      const creds = { ...(existing ? credsOf(existing) : {}), ...Object.fromEntries(entered) };
      // YouTube のクライアントを替えたら、前の連携は使えないので外す
      if (kind === "youtube" && entered.some(([k]) => k === "clientId" || k === "clientSecret")) delete creds.refreshToken;
      fields.cred_enc = encryptJson(creds);
    }
    const query = existing ? db().from("autopost_sites").update(fields).eq("id", existing.id) : db().from("autopost_sites").insert(fields);
    return { site: toSite(must(await query.select("*").single()) as SiteRow) };
  },
  async siteDelete(b) {
    must(await db().from("autopost_sites").delete().eq("id", str(b.id)));
    return { ok: true };
  },
  /** 控えておいたログイン情報を見る（手で貼るサイトだけ） */
  async siteSecret(b) {
    const row = await getSiteRow(str(b.id));
    if (row.kind !== "manual") throw new UserError("この投稿先の鍵は表示できません");
    return { creds: credsOf(row) };
  },

  // ---- 文を作る・投稿 ----
  async generate(b) {
    const video = await getVideo(str(b.videoId));
    const { frames } = must(await db().from("autopost_videos").select("frames").eq("id", video.id).single()) as { frames: string[] };
    const ids = Array.isArray(b.siteIds) ? b.siteIds.map((x) => str(x)) : [];
    // 投稿済みのものは作り直さない（会員サイトに出ている文が勝手に変わったり、下書きに戻ったりしないように）
    const posted = (must(await db().from("autopost_posts").select("site_id,status").eq("video_id", video.id)) as Pick<Post, "site_id" | "status">[])
      .filter((p) => p.status === "posted")
      .map((p) => p.site_id);
    const rows = (must(await db().from("autopost_sites").select("*").in("id", ids)) as SiteRow[]).map(toSite).filter((s) => !posted.includes(s.id));
    if (rows.length === 0) return { posts: [], ai: hasAi() };
    const { drafts, ai } = await generateDrafts({ ...video, frames }, rows);
    const posts = must(
      await db()
        .from("autopost_posts")
        .upsert(drafts.map((d) => ({ video_id: video.id, site_id: d.site_id, title: d.title, body: d.body, status: "draft", url: "", error: "", posted_at: null })), { onConflict: "video_id,site_id" })
        .select("*"),
    ) as Post[];
    return { posts, ai };
  },
  async postSave(b) {
    const post = must(await db().from("autopost_posts").select("*").eq("id", str(b.id)).maybeSingle()) as Post | null;
    if (!post) throw new UserError("投稿が見つかりません");
    const fields: Record<string, unknown> = {};
    if (typeof b.title === "string") fields.title = str(b.title, 500);
    if (typeof b.body === "string") fields.body = str(b.body, 10000);
    // 手で貼ったあとの「投稿済みにする」
    if (b.status === "posted") Object.assign(fields, { status: "posted", posted_at: new Date().toISOString(), error: "", url: /^https?:\/\//.test(str(b.url)) ? str(b.url, 500) : post.url });
    if (b.status === "draft") Object.assign(fields, { status: "draft", posted_at: null, url: "", error: "" });
    return { post: must(await db().from("autopost_posts").update(fields).eq("id", post.id).select("*").single()) as Post };
  },
  async postDelete(b) {
    must(await db().from("autopost_posts").delete().eq("id", str(b.id)));
    return { ok: true };
  },
  async publish(b) {
    const c = db();
    const post = must(await c.from("autopost_posts").select("*").eq("id", str(b.id)).maybeSingle()) as Post | null;
    if (!post) throw new UserError("投稿が見つかりません");
    const row = await getSiteRow(post.site_id);
    const site = toSite(row);
    const video = await getVideo(post.video_id);
    if (!KINDS[site.kind].autoPost) throw new UserError("この投稿先は自動では投稿できません。文をコピーして貼り付けてください");
    // 決まりは投稿の直前にもう一度かける（手で直したあとでも、必ず入れる文が落ちないように）
    const text = applyRules(site, post);
    const save = async (fields: Record<string, unknown>) =>
      must(await c.from("autopost_posts").update({ ...text, ...fields }).eq("id", post.id).select("*").single()) as Post;
    await save({ status: "posting", error: "" });
    try {
      let url: string;
      if (site.kind === "own") {
        if (!video.path) throw new UserError("この動画はまだアップロードが終わっていません");
        url = `/members/watch/${post.id}`;
      } else {
        // 相手のサイトが取りに来る場合もあるので、URL の期限は長めに
        const sourceUrl = await signedUrl(video.path, 6 * 3600);
        url = await publishExternal(site.kind as "youtube" | "x" | "instagram", { post: text, video, sourceUrl, rules: site.rules, creds: credsOf(row) });
      }
      return { post: await save({ status: "posted", url, posted_at: new Date().toISOString() }) };
    } catch (e) {
      const message = e instanceof UserError ? e.message : `投稿に失敗しました：${e instanceof Error ? e.message : String(e)}`;
      return { post: await save({ status: "failed", error: message.slice(0, 1000) }) };
    }
  },

  // ---- 会員 ----
  async memberSave(b) {
    const id = str(b.id);
    const fields: Record<string, unknown> = {};
    if (typeof b.name === "string") fields.name = str(b.name, 100).trim();
    if (typeof b.active === "boolean") fields.active = b.active;
    const password = str(b.password, 200);
    if (password) {
      if (password.length < 8) throw new UserError("パスワードは 8 文字以上にしてください");
      fields.pass_hash = hashPassword(password);
    }
    if (id) return { member: must(await db().from("autopost_members").update(fields).eq("id", id).select(MEMBER_COLUMNS).single()) as Member };
    const loginId = str(b.loginId, 100).trim().toLowerCase();
    if (!/^[a-z0-9._@+-]{3,100}$/.test(loginId)) throw new UserError("ログイン ID は半角の英数字（3 文字以上。メールアドレスでも可）にしてください");
    if (!password) throw new UserError("パスワードを入れてください");
    const result = await db().from("autopost_members").insert({ ...fields, login_id: loginId }).select(MEMBER_COLUMNS).single();
    if (result.error?.code === "23505") throw new UserError("そのログイン ID はもう使われています");
    return { member: must(result) as Member };
  },
  async memberDelete(b) {
    must(await db().from("autopost_members").delete().eq("id", str(b.id)));
    return { ok: true };
  },
};

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const denied = await guardApi(request, "/api/autopost");
  if (denied) return denied;
  const { action } = await params;
  const handler = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!handler) return Response.json({ error: "その操作はありません" }, { status: 404 });
  try {
    const body = (await request.json().catch(() => ({}))) as Body;
    return Response.json(await handler(body, request));
  } catch (e) {
    if (e instanceof UserError) return Response.json({ error: e.message }, { status: 400 });
    console.error(`autopost ${action} failed`, e);
    return Response.json({ error: `うまくいきませんでした：${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
