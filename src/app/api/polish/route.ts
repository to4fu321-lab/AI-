import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * 現場が書いた箇条書きのメモを、管理者が判断しやすい報告文に整える。
 *
 * ここはサーバー側でだけ動く。APIキーは環境変数からしか読まず、
 * ブラウザには一切渡さない（クライアントから直接 Anthropic を叩かせない）。
 */

const PolishedSchema = z.object({
  title: z.string().describe("40字以内の報告タイトル。何がどう困るかが一目で分かる言い方"),
  body: z.string().describe("整えた報告本文。3〜4文程度"),
});

const SYSTEM = `あなたは物流センターの改善報告を整える編集者です。
現場スタッフが書いた短いメモを、管理者が読んで判断できる報告文に整えてください。

必ず守ること:
- 書かれていないことを足さない。原因の推測、対策の提案、被害の誇張は禁止
- 現場の固有の言い方（3号台車、A-1通路、○番バースなど）はそのまま残す
- 事実と、困っている内容だけを書く
- タイトルは40字以内。「何が」「どう困るか」が分かる言い方にする
- 本文は3〜4文程度。長くしない
- ていねいすぎる敬語は使わない。現場の報告として自然な書き方にする
- 日本語で書く

メモが短すぎて報告文にできない場合でも、書かれている範囲だけで整えてください。`;

interface PolishRequest {
  notes?: unknown;
  category?: unknown;
  area?: unknown;
}

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "AIサポートは現在使えません（APIキーが未設定です）" },
      { status: 503 },
    );
  }

  let payload: PolishRequest;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "リクエストを読み取れませんでした" }, { status: 400 });
  }

  const notes = typeof payload.notes === "string" ? payload.notes.trim() : "";
  if (!notes) {
    return Response.json({ error: "メモが空です" }, { status: 400 });
  }
  if (notes.length > 2000) {
    return Response.json({ error: "メモが長すぎます" }, { status: 400 });
  }

  const category = typeof payload.category === "string" ? payload.category : "";
  const area = typeof payload.area === "string" ? payload.area : "";
  const context = [category ? `カテゴリ: ${category}` : "", area ? `場所: ${area}` : ""]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 2000,
      system: SYSTEM,
      output_config: {
        // 現場を待たせないことを優先する。整えるだけの作業に深い思考はいらない
        effort: "low",
        format: zodOutputFormat(PolishedSchema),
      },
      messages: [
        {
          role: "user",
          content: context ? `${context}\n\nメモ:\n${notes}` : `メモ:\n${notes}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "この内容は整えられませんでした" }, { status: 422 });
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return Response.json({ error: "整えた文を受け取れませんでした" }, { status: 502 });
    }

    return Response.json({ title: parsed.title.slice(0, 40), body: parsed.body });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return Response.json({ error: "APIキーが正しくありません" }, { status: 502 });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return Response.json(
        { error: "混み合っています。少し待ってからもう一度お試しください" },
        { status: 429 },
      );
    }
    console.error("polish failed", error);
    return Response.json({ error: "整えるのに失敗しました" }, { status: 502 });
  }
}
