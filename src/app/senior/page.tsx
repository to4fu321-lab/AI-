'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
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
  { value: 'genki',   emoji: '😄', label: '元気！',     color: 'bg-green-100 border-green-400 text-green-800' },
  { value: 'maama',   emoji: '🙂', label: 'まあまあ',   color: 'bg-yellow-100 border-yellow-400 text-yellow-800' },
  { value: 'shindoi', emoji: '😔', label: 'しんどい',   color: 'bg-blue-100 border-blue-400 text-blue-800' },
];

export default function SeniorPage() {
  const [checkin, setCheckin] = useState<ReturnType<typeof getTodayCheckin>>(null);
  const [streak, setStreak] = useState(0);
  const [unread, setUnread] = useState(0);
  const [justWatered, setJustWatered] = useState(false);
  const [name, setName] = useState('');
  const [inputName, setInputName] = useState('');
  const [showNameInput, setShowNameInput] = useState(false);

  useEffect(() => {
    setCheckin(getTodayCheckin());
    setStreak(getStreak());
    setUnread(getUnreadCount());
    const savedName = getSeniorName();
    if (savedName) {
      setName(savedName);
    } else {
      setShowNameInput(true);
    }
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

  if (showNameInput) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6">
        <div className="text-6xl mb-6">🌱</div>
        <h2 className="text-2xl font-bold text-green-800 mb-2">はじめまして！</h2>
        <p className="text-amber-800 mb-8 text-center">お名前を教えてください</p>
        <input
          type="text"
          value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          placeholder="例：田中 花子"
          className="w-full border-2 border-green-300 rounded-2xl px-4 py-4 text-xl text-center mb-4 bg-white focus:outline-none focus:border-green-500"
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
      {/* ヘッダー */}
      <div className="px-5 pt-8 pb-4">
        <p className="text-amber-700 text-base">おはようございます</p>
        <h1 className="text-3xl font-bold text-green-800">{name}さん 👋</h1>
      </div>

      {/* 畑 */}
      <div className="px-5 mb-5">
        <Garden streak={streak} justWatered={justWatered} />
      </div>

      {/* 今日のチェックイン */}
      <div className="px-5 mb-6">
        {checkin ? (
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-green-100">
            <p className="text-green-700 font-bold text-lg mb-1">✅ 今日のチェックイン完了！</p>
            <p className="text-amber-700">
              今日の気分：{MOOD_OPTIONS.find((m) => m.value === checkin.mood)?.emoji}{' '}
              {MOOD_OPTIONS.find((m) => m.value === checkin.mood)?.label}
            </p>
            <p className="text-sm text-gray-500 mt-2">また明日もチェックインしてね 🌱</p>
          </div>
        ) : (
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-amber-100">
            <p className="text-xl font-bold text-amber-800 mb-4">今日の気分は？</p>
            <div className="flex gap-3">
              {MOOD_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => handleCheckin(m.value)}
                  className={`flex-1 flex flex-col items-center gap-2 py-4 rounded-2xl border-2 font-bold text-sm transition-transform active:scale-95 ${m.color}`}
                >
                  <span className="text-3xl">{m.emoji}</span>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 今日のミッション */}
      <div className="px-5 mb-6">
        <h2 className="text-lg font-bold text-amber-800 mb-3">📋 今日のミッション</h2>
        <div className="flex flex-col gap-3">
          {MISSIONS.map((mission, i) => (
            <div
              key={i}
              className="bg-white rounded-2xl p-4 shadow-sm border border-amber-100 flex items-center gap-4"
            >
              <span className="text-3xl">{mission.icon}</span>
              <div>
                <p className="font-bold text-gray-800">{mission.label}</p>
                <p className="text-xs text-amber-600">{mission.category}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 下部ナビゲーション */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-amber-100 flex">
        <div className="flex-1 py-4 flex flex-col items-center gap-1 text-green-700">
          <span className="text-2xl">🏡</span>
          <span className="text-xs font-bold">ホーム</span>
        </div>
        <Link href="/senior/messages" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-1 text-amber-600 relative">
            <span className="text-2xl">💌</span>
            <span className="text-xs font-bold">メッセージ</span>
            {unread > 0 && (
              <span className="absolute top-2 right-6 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                {unread}
              </span>
            )}
          </div>
        </Link>
        <Link href="/" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-1 text-gray-400">
            <span className="text-2xl">🔄</span>
            <span className="text-xs font-bold">切り替え</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
