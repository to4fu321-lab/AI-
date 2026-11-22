import "server-only";
import { db, must } from "./db";
import type { Post, Video } from "./types";

/** 会員制動画サイトに並ぶ動画（「自分の会員サイト」へ投稿済みのもの） */

export interface MemberVideo {
  postId: string;
  title: string;
  body: string;
  postedAt: string | null;
  video: Pick<Video, "id" | "path" | "thumb" | "duration">;
}

export interface MemberSite {
  /** 会員サイトの名前（投稿先「自分の会員サイト」に付けた名前） */
  name: string;
  videos: MemberVideo[];
}

export async function loadMemberSite(): Promise<MemberSite> {
  const c = db();
  const site = must(await c.from("autopost_sites").select("id,name,enabled").eq("kind", "own").maybeSingle()) as { id: string; name: string; enabled: boolean } | null;
  if (!site || !site.enabled) return { name: site?.name ?? "メンバー限定シアター", videos: [] };
  const posts = must(await c.from("autopost_posts").select("*").eq("site_id", site.id).eq("status", "posted").order("posted_at", { ascending: false })) as Post[];
  if (posts.length === 0) return { name: site.name, videos: [] };
  const videos = must(await c.from("autopost_videos").select("id,path,thumb,duration").in("id", posts.map((p) => p.video_id))) as MemberVideo["video"][];
  return {
    name: site.name,
    videos: posts.flatMap((p) => {
      const video = videos.find((v) => v.id === p.video_id);
      return video?.path ? [{ postId: p.id, title: p.title, body: p.body, postedAt: p.posted_at, video }] : [];
    }),
  };
}
