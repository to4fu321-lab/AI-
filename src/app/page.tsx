import { HomeClient } from "@/components/HomeClient";
import { getVideos } from "@/lib/videos";

export const dynamic = "force-dynamic";

export default async function Home() {
  const videos = await getVideos();
  return <HomeClient videos={videos} />;
}
