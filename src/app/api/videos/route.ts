import { NextRequest, NextResponse } from "next/server";
import { getVideos } from "@/lib/videos";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";

export async function GET() {
  const videos = await getVideos();
  return NextResponse.json({ videos });
}

interface IngestBody {
  platform: "youtube" | "x";
  sourceUrl: string;
  embedId: string;
  title: string;
  aiSummary: string;
  category: string;
  region: string;
  channelName: string;
  postedAt: string;
  /** ISO文字列。省略時は現在時刻として登録される */
  publishedAt?: string;
  likes?: number;
  favorites?: number;
  engagement?: { now?: number; today?: number; week?: number };
}

const REQUIRED_FIELDS: (keyof IngestBody)[] = [
  "platform",
  "sourceUrl",
  "embedId",
  "title",
  "aiSummary",
  "category",
  "region",
  "channelName",
  "postedAt",
];

/**
 * OpenClaw / Make などの外部ワークフローから新しいバズ動画・投稿を登録するための取り込み口。
 * ヘッダー `x-api-key` が環境変数 INGEST_API_KEY と一致する場合のみ書き込みを許可する。
 */
export async function POST(request: NextRequest) {
  const apiKey = process.env.INGEST_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "INGEST_API_KEY is not configured on the server" },
      { status: 500 }
    );
  }

  if (request.headers.get("x-api-key") !== apiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as IngestBody | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const missing = REQUIRED_FIELDS.filter((field) => !body[field]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Missing required fields: ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  if (body.platform !== "youtube" && body.platform !== "x") {
    return NextResponse.json(
      { error: "platform must be 'youtube' or 'x'" },
      { status: 400 }
    );
  }

  const supabaseAdmin = getSupabaseAdminClient();
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase admin client is not configured on the server" },
      { status: 500 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("buzztube_videos")
    .insert({
      platform: body.platform,
      source_url: body.sourceUrl,
      embed_id: body.embedId,
      title: body.title,
      ai_summary: body.aiSummary,
      category: body.category,
      region: body.region,
      channel_name: body.channelName,
      posted_at: body.postedAt,
      published_at: body.publishedAt ?? new Date().toISOString(),
      likes: body.likes ?? 0,
      favorites: body.favorites ?? 0,
      engagement_now: body.engagement?.now ?? 0,
      engagement_today: body.engagement?.today ?? 0,
      engagement_week: body.engagement?.week ?? 0,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ video: data }, { status: 201 });
}
