'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import Garden from '@/components/Garden';
import {
  getTodayCheckin,
  addCheckin,
  getStreak,
  getUnreadCount,
  getSeniorName,
  setSeniorName,
  type Mood,
} from '@/lib/storage';

const MISSIONS = [
  { icon: '🚶', label: '外の空気を5分吸う', category: '体を動かす' },
  { icon: '💬', label: '誰かに一言話しかける', category: 'つながる' },
  { icon: '🧠', label: '今日のニュースを1つ読む', category: '頭を使う' },
];

const MOOD_OPTIONS: { value: Mood; emoji: string; label: string; color: string }[] = [
  { value: 'genki',   emoji: '😄', label: '元気！',   color: 'bg-green-100 border-green-500 text-green-900' },
  { value: 'maama',   emoji: '🙂', label: 'まあまあ', color: 'bg-yellow-100 border-yellow-500 text-yellow-900' },
  { value: 'shindoi', emoji: '😔', label: 'しんどい', color: 'bg-blue-100 border-blue-500 text-blue-900' },
];

export default function SeniorPage() {
  const [checkin, setCheckin] = useState<ReturnType<typeof getTodayCheckin>>(null);
  const [streak, setStreak] = useState(0);
  const [unread, setUnread] = useState(0);
  const [justWatered, setJustWatered] = useState(false);
  const [name, setName] = useState('');
  const [inputName, setInputName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);
  // ② ミッション完了状態
  const [doneMissions, setDoneMissions] = useState<boolean[]>([false, false, false]);

  useEffect(() => {
    setCheckin(getTodayCheckin());
    setStreak(getStreak());
    setUnread(getUnreadCount());
    const savedName = getSeniorName();
    if (savedName) setName(savedName);
    else setShowNameInput(true);
  }, []);

  const handleCheckin = (mood: Mood) => {
    addCheckin(mood);
    setCheckin(getTodayCheckin());
    setStreak(getStreak());
    setJustWatered(true);
    setTimeout(() => setJustWatered(false), 2000);
  };

  const handleNameSubmit = () => {
    if (inputName.trim()) {
      setSeniorName(inputName.trim());
      setName(inputName.trim());
      setShowNameInput(false);
    }
  };

  const toggleMission = (i: number) => {
    setDoneMissions((prev) => {
      const next = [...prev];
      next[i] = !next[i];
      return next;
    });
  };

  if (showNameInput) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6">
        <div className="text-6xl mb-6">🌱</div>
        {/* ① コントラスト改善: text-green-900 / text-slate-700 */}
        <h2 className="text-2xl font-bold text-green-900 mb-2">はじめまして！</h2>
        <p className="text-slate-700 mb-8 text-center text-lg">お名前を教えてください</p>
        <input
          type="text"
          value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          placeholder="例：田中 花子"
          className="w-full border-2 border-green-400 rounded-2xl px-4 py-4 text-xl text-center mb-4 bg-white focus:outline-none focus:border-green-600 text-slate-900"
          onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
        />
        <button
          onClick={handleNameSubmit}
          className="w-full bg-green-600 text-white rounded-2xl py-4 text-xl font-bold"
        >
          はじめる 🌿
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen pb-24">
      {/* ヘッダー ① コントラスト改善 */}
      <div className="px-5 pt-8 pb-4">
        <p className="text-amber-800 text-base font-medium">おはようございます</p>
        <h1 className="text-3xl font-bold text-green-900">{name}さん 👋</h1>
      </div>

      {/* ③ 畑（Framer Motion アニメーション付き） */}
      <div className="px-5 mb-5">
        <Garden streak={streak} justWatered={justWatered} />
      </div>

      {/* 今日のチェックイン */}
      <div className="px-5 mb-6">
        {checkin ? (
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-green-200">
            <p className="text-green-800 font-bold text-lg mb-1">✅ 今日のチェックイン完了！</p>
            <p className="text-slate-700 text-base">
              今日の気分：{MOOD_OPTIONS.find((m) => m.value === checkin.mood)?.emoji}{' '}
              {MOOD_OPTIONS.find((m) => m.value === checkin.mood)?.label}
            </p>
            {/* ① コントラスト改善: text-gray-500 → text-slate-600 */}
            <p className="text-slate-600 mt-2">また明日もチェックインしてね 🌱</p>
          </div>
        ) : (
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-amber-200">
            <p className="text-xl font-bold text-amber-900 mb-4">今日の気分は？</p>
            <div className="flex gap-3">
              {MOOD_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => handleCheckin(m.value)}
                  className={`flex-1 flex flex-col items-center gap-2 py-5 rounded-2xl border-2 font-bold text-base transition-transform active:scale-95 ${m.color}`}
                >
                  <span className="text-4xl">{m.emoji}</span>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* お手紙ポストボタン */}
      <div className="px-5 mb-4">
        <Link href="/senior/post">
          <motion.button
            whileTap={{ scale: 0.97 }}
            className="w-full bg-pink-500 text-white rounded-3xl py-5 px-6 flex items-center gap-4 shadow-lg"
          >
            <span className="text-4xl">📮</span>
            <div className="text-left flex-1">
              <p className="text-xl font-black">お手紙ポスト</p>
              <p className="text-pink-100 text-sm font-medium">写真を撮って家族に送る</p>
            </div>
            <span className="text-2xl">→</span>
          </motion.button>
        </Link>
      </div>

      {/* 日めくりカレンダーボタン */}
      <div className="px-5 mb-5">
        <Link href="/senior/calendar">
          <motion.button
            whileTap={{ scale: 0.97 }}
            className="w-full bg-red-600 text-white rounded-3xl py-5 px-6 flex items-center gap-4 shadow-lg"
          >
            <span className="text-4xl">📅</span>
            <div className="text-left flex-1">
              <p className="text-xl font-black">今日の日めくり</p>
              <p className="text-red-200 text-sm font-medium">昭和クイズに挑戦！</p>
            </div>
            <motion.span
              animate={{ x: [0, 4, 0] }}
              transition={{ repeat: Infinity, duration: 1.2 }}
              className="text-2xl"
            >
              →
            </motion.span>
          </motion.button>
        </Link>
      </div>

      {/* ② 今日のミッション（カード全体がタップエリア） */}
      <div className="px-5 mb-6">
        <h2 className="text-lg font-bold text-amber-900 mb-3">📋 今日のミッション</h2>
        <div className="flex flex-col gap-3">
          {MISSIONS.map((mission, i) => (
            <motion.button
              key={i}
              onClick={() => toggleMission(i)}
              whileTap={{ scale: 0.97 }}
              className={`w-full text-left rounded-2xl p-5 shadow-sm border-2 flex items-center gap-4 transition-colors ${
                doneMissions[i]
                  ? 'bg-green-50 border-green-400'
                  : 'bg-white border-amber-200 active:bg-amber-50'
              }`}
            >
              <span className="text-4xl flex-shrink-0">{mission.icon}</span>
              <div className="flex-1 min-w-0">
                {/* ① コントラスト改善: text-gray-800 → text-slate-900 */}
                <p className={`font-bold text-slate-900 text-base leading-snug ${doneMissions[i] ? 'line-through text-slate-500' : ''}`}>
                  {mission.label}
                </p>
                <p className="text-sm text-amber-700 font-medium mt-0.5">{mission.category}</p>
              </div>
              <AnimatePresence>
                {doneMissions[i] && (
                  <motion.span
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    className="text-3xl flex-shrink-0"
                  >
                    ✅
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          ))}
        </div>

        {/* 全完了メッセージ */}
        <AnimatePresence>
          {doneMissions.every(Boolean) && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 bg-green-100 border-2 border-green-400 rounded-2xl p-4 text-center"
            >
              <p className="text-xl font-bold text-green-900">🎉 今日のミッション全部完了！</p>
              <p className="text-slate-700 mt-1">素晴らしい！畑もよろこんでいるよ 🌻</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 下部ナビゲーション */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-amber-100 flex">
        <div className="flex-1 py-4 flex flex-col items-center gap-1 text-green-800">
          <span className="text-2xl">🏡</span>
          <span className="text-xs font-bold">ホーム</span>
        </div>
        <Link href="/senior/messages" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-1 text-amber-700 relative">
            <span className="text-2xl">💌</span>
            <span className="text-xs font-bold">メッセージ</span>
            {unread > 0 && (
              <span className="absolute top-2 right-6 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                {unread}
              </span>
            )}
          </div>
        </Link>
        <Link href="/" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-1 text-slate-500">
            <span className="text-2xl">🔄</span>
            <span className="text-xs font-bold">切り替え</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
