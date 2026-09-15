import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * 管理者が現場へ送るお知らせの下書きを作る。
 *
 * 集計はアプリ側で終わらせてから渡す。AIには文章化だけを任せ、
 * 数を数えさせたり推測させたりしない（現場に配る連絡に誤った数字を載せないため）。
 * polish と同じく、APIキーはサーバーの環境変数からしか読まない。
 */

const DraftSchema = z.object({
  title: z.string().describe("40字以内のお知らせタイトル。何の連絡かが一目で分かる言い方"),
  body: z.string().describe("お知らせ本文。3〜5文程度"),
});

const SYSTEM = `あなたは物流センターのセンター長が現場スタッフへ送る連絡文を書く担当者です。

必ず守ること:
- 与えられた数字だけを使う。自分で計算し直したり、書かれていない数字を足したりしない
- 与えられていない事実（原因、今後の予定、効果の推測）を作らない
- 現場スタッフが読む文章にする。専門用語やビジネス敬語を避け、短く区切る
- 感謝を伝える場合も、大げさにせず一言だけにする
- タイトルは40字以内。本文は3〜5文程度
- 箇条書きを使ってよい。使う場合は行頭に「・」を付ける
- 日本語で書く`;

const MONTHLY_INSTRUCTION = `今月の改善活動のまとめを、現場スタッフ向けのお知らせにしてください。
報告してくれた人が「自分の報告がどうなったか」を感じられる文章にします。`;

const SHARE_INSTRUCTION = `他の拠点で採用された改善を、自分の拠点でも取り入れることを知らせるお知らせにしてください。
どこの拠点の、どんな改善で、何が良くなるのかが伝わる文章にします。`;

interface DraftRequest {
  kind?: unknown;
  site?: unknown;
  summary?: unknown;
  report?: unknown;
}

/** そのまま prompt に入れて良い短い文字列だけを取り出す */
function text(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function monthlyContext(summary: Record<string, unknown>): string {
  const lines: string[] = [];
  const push = (label: string, value: number | null, unit = "件") => {
    if (value !== null) lines.push(`${label}: ${value}${unit}`);
  };
  push("対象の月", num(summary.month), "月");
  push("今月届いた報告", num(summary.reportCount));
  push("報告してくれた人数", num(summary.reporterCount), "人");
  push("今月採用が決まった件数", num(summary.adoptedCount));
  push("今月改善が完了した件数", num(summary.doneCount));
  push("今月の危険に関する報告", num(summary.dangerCount));
  push("他拠点へ横展開した件数", num(summary.sharedCount));

  const topCategory = text(summary.topCategory, 20);
  const topCount = num(summary.topCategoryCount);
  if (topCategory && topCategory !== "—" && topCount) {
    lines.push(`いちばん多かったカテゴリ: ${topCategory}（${topCount}件）`);
  }

  const highlights = Array.isArray(summary.doneHighlights)
    ? summary.doneHighlights.map((item) => text(item)).filter(Boolean).slice(0, 3)
    : [];
  if (highlights.length > 0) {
    lines.push(`完了した改善で、実際に変わったこと:\n${highlights.map((h) => `・${h}`).join("\n")}`);
  }

  return lines.join("\n");
}

function shareContext(report: Record<string, unknown>): string {
  // 何の改善かが分からないまま呼ぶと、AIが中身を作ってしまう
  const title = text(report.title, 80);
  if (!title) return "";

  return [
    text(report.site, 40) ? `改善が生まれた拠点: ${text(report.site, 40)}` : "",
    `改善の内容: ${title}`,
    text(report.body) ? `くわしい内容: ${text(report.body)}` : "",
    text(report.result) ? `その拠点で実際に変わったこと: ${text(report.result)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "AIの下書きは現在使えません（APIキーが未設定です）" },
      { status: 503 },
    );
  }

  let payload: DraftRequest;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "リクエストを読み取れませんでした" }, { status: 400 });
  }

  const kind = payload.kind === "monthly" || payload.kind === "share" ? payload.kind : null;
  if (!kind) {
    return Response.json({ error: "下書きの種類が不正です" }, { status: 400 });
  }

  const source = kind === "monthly" ? payload.summary : payload.report;
  if (typeof source !== "object" || source === null) {
    return Response.json({ error: "材料が足りません" }, { status: 400 });
  }

  const context =
    kind === "monthly"
      ? monthlyContext(source as Record<string, unknown>)
      : shareContext(source as Record<string, unknown>);
  if (!context) {
    return Response.json({ error: "材料が足りません" }, { status: 400 });
  }

  const instruction = kind === "monthly" ? MONTHLY_INSTRUCTION : SHARE_INSTRUCTION;
  const site = text(payload.site, 40);

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 2000,
      system: SYSTEM,
      output_config: {
        effort: "low",
        format: zodOutputFormat(DraftSchema),
      },
      messages: [
        {
          role: "user",
          content: [
            instruction,
            site ? `\n送り先の拠点: ${site}` : "",
            `\n\n使ってよい材料（これ以外の数字や事実を書かないこと）:\n${context}`,
          ].join(""),
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return Response.json({ error: "この内容は下書きできませんでした" }, { status: 422 });
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return Response.json({ error: "下書きを受け取れませんでした" }, { status: 502 });
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
    console.error("notice draft failed", error);
    return Response.json({ error: "下書きに失敗しました" }, { status: 502 });
  }
}
