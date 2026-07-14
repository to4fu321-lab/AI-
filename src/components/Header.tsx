"use client";

import Link from "next/link";
import type { SortMode } from "@/data/videos";

interface HeaderProps {
  categories: string[];
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  regions: string[];
  selectedRegion: string;
  onSelectRegion: (region: string) => void;
  platforms: { value: string; label: string }[];
  selectedPlatform: string;
  onSelectPlatform: (platform: string) => void;
  periods: { value: SortMode; label: string }[];
  selectedPeriod: SortMode;
  onSelectPeriod: (period: SortMode) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function Header({
  categories,
  selectedCategory,
  onSelectCategory,
  regions,
  selectedRegion,
  onSelectRegion,
  platforms,
  selectedPlatform,
  onSelectPlatform,
  periods,
  selectedPeriod,
  onSelectPeriod,
  searchQuery,
  onSearchChange,
}: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/85 backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-950/85">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 text-xl font-black tracking-tight text-neutral-900 dark:text-white"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-500 to-orange-400 text-base text-white">
              🔥
            </span>
            Buzz<span className="text-fuchsia-500">Tube</span>
          </Link>

          <div className="hidden max-w-md flex-1 sm:block">
            <SearchInput value={searchQuery} onChange={onSearchChange} />
          </div>

          <button
            type="button"
            className="shrink-0 rounded-full bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            動画を投稿
          </button>
        </div>

        <div className="sm:hidden">
          <SearchInput value={searchQuery} onChange={onSearchChange} />
        </div>

        <nav className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {categories.map((category) => {
            const isActive = category === selectedCategory;
            return (
              <button
                key={category}
                type="button"
                onClick={() => onSelectCategory(category)}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                  isActive
                    ? "bg-fuchsia-500 text-white shadow-sm shadow-fuchsia-500/30"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                }`}
              >
                {category}
              </button>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-neutral-100 pt-2 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-neutral-400">地域</span>
            <div className="flex gap-1.5">
              {regions.map((region) => {
                const isActive = region === selectedRegion;
                return (
                  <button
                    key={region}
                    type="button"
                    onClick={() => onSelectRegion(region)}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      isActive
                        ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                        : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                    }`}
                  >
                    {region}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-neutral-400">媒体</span>
            <div className="flex gap-1.5">
              {platforms.map(({ value, label }) => {
                const isActive = value === selectedPlatform;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onSelectPlatform(value)}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      isActive
                        ? "bg-sky-500 text-white"
                        : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-neutral-400">急上昇</span>
            <div className="flex gap-1.5">
              {periods.map(({ value, label }) => {
                const isActive = value === selectedPeriod;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onSelectPeriod(value)}
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition ${
                      isActive
                        ? "bg-orange-500 text-white"
                        : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative w-full">
      <svg
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="動画・キーワードを検索"
        className="w-full rounded-full border border-neutral-200 bg-neutral-50 py-2 pl-10 pr-4 text-sm text-neutral-900 outline-none transition focus:border-fuchsia-400 focus:bg-white dark:border-neutral-700 dark:bg-neutral-900 dark:text-white"
      />
    </div>
  );
}
