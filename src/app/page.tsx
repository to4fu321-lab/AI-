"use client";

import { useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { VideoCard } from "@/components/VideoCard";
import { AdSlot } from "@/components/AdSlot";
import { TrendingWidget } from "@/components/TrendingWidget";
import { Footer } from "@/components/Footer";
import { buzzVideos, categories, type BuzzVideo } from "@/data/videos";

const ALL_CATEGORY = "すべて";

export default function Home() {
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORY);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredVideos = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return buzzVideos.filter((video) => {
      const matchesCategory =
        selectedCategory === ALL_CATEGORY || video.category === selectedCategory;
      const matchesQuery =
        query === "" ||
        video.title.toLowerCase().includes(query) ||
        video.aiSummary.toLowerCase().includes(query);
      return matchesCategory && matchesQuery;
    });
  }, [selectedCategory, searchQuery]);

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <Header
        categories={[ALL_CATEGORY, ...categories]}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-black text-neutral-900 dark:text-white sm:text-3xl">
            今、SNSでバズってる動画 🔥
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            X（旧Twitter）やYouTubeで話題の動画をAIが自動収集・要約してお届けします。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px]">
          <section
            aria-label="動画一覧"
            className="grid grid-cols-1 gap-6 sm:grid-cols-2"
          >
            {filteredVideos.map((video, index) => (
              <VideoCardWithAd key={video.id} video={video} index={index} />
            ))}

            {filteredVideos.length === 0 && (
              <p className="col-span-full py-16 text-center text-neutral-400">
                該当する動画が見つかりませんでした。
              </p>
            )}
          </section>

          <aside className="space-y-6 lg:sticky lg:top-24 lg:h-fit">
            <AdSlot className="h-64" />
            <TrendingWidget videos={buzzVideos} />
            <AdSlot className="h-96" />
          </aside>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function VideoCardWithAd({ video, index }: { video: BuzzVideo; index: number }) {
  const showAdAfter = (index + 1) % 2 === 0;

  return (
    <>
      <VideoCard video={video} />
      {showAdAfter && <AdSlot className="min-h-[280px]" />}
    </>
  );
}
