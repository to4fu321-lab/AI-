import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { UserError } from "./db";
import { applyRules, KINDS, type Site } from "./types";

export interface Draft {
  site_id: string;
  title: string;
  body: string;
}

const SYSTEM = `あなたは動画を各 SNS・動画サイトに投稿する担当者です。
動画から抜き出したコマ（時間順）とメモを見て、投稿先ごとに題名と本文を日本語で書きます。

- 動画に実際に映っているもの・メモに書かれていることだけをもとにする。見えていない事実（人名・場所・数字・商品名など）を作らない
- 投稿先ごとの読者と文化に合わせて書き分ける（同じ文の使い回しにしない）
- 各投稿先の「決まり」（口調、必ず入れる文、ハッシュタグ、文字数の上限）を守る。必ず入れる文は一字一句そのまま本文に入れる
- 題名を使わない投稿先（uses_title が false）は title を空文字にする
- 大げさな煽りや、内容と合わない釣り題名にしない`;

const SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: { site_id: { type: "string" }, title: { type: "string" }, body: { type: "string" } },
        required: ["site_id", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

export function hasAi(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function parseFrame(dataUrl: string): { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return m ? { media_type: m[1] as "image/jpeg", data: m[2] } : null;
}

/** AI が使えないとき（鍵が未設定）の仮の文。メモとファイル名から作る */
function fallback(video: { name: string; memo: string }, sites: Site[]): Draft[] {
  const title = video.memo.split("\n")[0]?.trim() || video.name.replace(/\.[^.]+$/, "");
  return sites.map((s) => ({ site_id: s.id, title, body: video.memo.trim() || title }));
}

/**
 * 投稿先ごとの題名と本文を作る。
 * 最後に applyRules を通すので、AI が決まりを落としても「必ず入れる文」と文字数の上限は守られる。
 */
export async function generateDrafts(
  video: { name: string; memo: string; duration: number; frames: string[] },
  sites: Site[],
): Promise<{ drafts: Draft[]; ai: boolean }> {
  if (sites.length === 0) return { drafts: [], ai: false };
  const finish = (drafts: Draft[]) =>
    sites.map((s) => {
      const d = drafts.find((x) => x.site_id === s.id) ?? { title: "", body: "" };
      return { site_id: s.id, ...applyRules(s, d) };
    });
  if (!hasAi()) return { drafts: finish(fallback(video, sites)), ai: false };

  const images = video.frames.map(parseFrame).filter((f) => f !== null);
  const brief = {
    video: { file_name: video.name, seconds: Math.round(video.duration), memo: video.memo || "（なし）" },
    sites: sites.map((s) => ({
      site_id: s.id,
      site: `${KINDS[s.kind].label}（${s.name}）`,
      uses_title: KINDS[s.kind].usesTitle,
      title_max_chars: KINDS[s.kind].usesTitle ? s.rules.titleMax : 0,
      body_max_chars: s.kind === "x" ? `${s.rules.bodyMax}（全角は 2 文字ぶんと数える。日本語ならおよそ ${Math.floor(s.rules.bodyMax / 2)} 字）` : s.rules.bodyMax,
      tone: s.rules.tone || "（指定なし）",
      must_include: s.rules.required || "（なし）",
      hashtags: s.rules.hashtags || "（なし）",
    })),
  };

  const client = new Anthropic();
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      // 断られたときは、API 側で別のモデルに自動で切り替えて続ける
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...images.map((source) => ({ type: "image" as const, source: { type: "base64" as const, ...source } })),
            { type: "text", text: `次の動画の投稿文を、すべての投稿先について作ってください。\n\n${JSON.stringify(brief, null, 2)}` },
          ],
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new UserError("AI の鍵（ANTHROPIC_API_KEY）が正しくありません");
    if (error instanceof Anthropic.RateLimitError) throw new UserError("AI が混み合っています。少し待ってからもう一度お試しください");
    if (error instanceof Anthropic.APIError) throw new UserError(`AI の呼び出しに失敗しました（${error.status ?? "通信"}）：${error.message}`);
    throw error;
  }
  if (response.stop_reason === "refusal") throw new UserError("AI がこの動画の文を作るのを断りました。メモを足すか、文を手で入れてください");
  if (response.stop_reason === "max_tokens") throw new UserError("AI の文が途中で切れました。もう一度お試しください");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  let parsed: { posts: Draft[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UserError("AI の返事を読み取れませんでした。もう一度お試しください");
  }
  return { drafts: finish(parsed.posts ?? []), ai: true };
}
