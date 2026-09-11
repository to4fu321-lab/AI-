import "server-only";
import { getSupabaseClient } from "./supabase";
import { FALLBACK_VIDEOS, type BuzzVideo } from "@/data/videos";

interface VideoRow {
  id: string;
  platform: "youtube" | "x";
  source_url: string;
  embed_id: string;
  title: string;
  ai_summary: string;
  category: string;
  region: string;
  channel_name: string;
  posted_at: string;
  published_at: string;
  likes: number;
  favorites: number;
  engagement_now: number;
  engagement_today: number;
  engagement_week: number;
}

function mapRow(row: VideoRow): BuzzVideo {
  return {
    id: row.id,
    platform: row.platform,
    sourceUrl: row.source_url,
    embedId: row.embed_id,
    title: row.title,
    aiSummary: row.ai_summary,
    category: row.category,
    region: row.region,
    channelName: row.channel_name,
    postedAt: row.posted_at,
    publishedAt: row.published_at,
    likes: row.likes,
    favorites: row.favorites,
    engagement: {
      now: row.engagement_now,
      today: row.engagement_today,
      week: row.engagement_week,
    },
  };
}

export async function getVideos(): Promise<BuzzVideo[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn(
      "Supabase env vars are not set (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY). Serving fallback videos."
    );
    return FALLBACK_VIDEOS;
  }

  const { data, error } = await supabase
    .from("buzztube_videos")
    .select(
      "id, platform, source_url, embed_id, title, ai_summary, category, region, channel_name, posted_at, published_at, likes, favorites, engagement_now, engagement_today, engagement_week"
    )
    .eq("is_published", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch buzztube_videos:", error.message);
    return FALLBACK_VIDEOS;
  }

  return (data as VideoRow[]).map(mapRow);
}
