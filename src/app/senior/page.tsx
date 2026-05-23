'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import Garden from '@/components/Garden';
import {
  getTodayCheckin, addCheckin, getStreak,
  getUnreadCount, getSeniorName, setSeniorName, type Mood,
} from '@/lib/storage';

const MOOD_OPTIONS: { value: Mood; emoji: string; label: string; color: string }[] = [
  { value: 'genki',   emoji: '😄', label: '元気！',   color: 'bg-green-100 border-green-500 text-green-900' },
  { value: 'maama',   emoji: '🙂', label: 'まあまあ', color: 'bg-yellow-100 border-yellow-500 text-yellow-900' },
  { value: 'shindoi', emoji: '😔', label: 'しんどい', color: 'bg-blue-100 border-blue-500 text-blue-900' },
];

export default function SeniorPage() {
  const [checkin, setCheckin]         = useState<ReturnType<typeof getTodayCheckin>>(null);
  const [streak, setStreak]           = useState(0);
  const [unread, setUnread]           = useState(0);
  const [justWatered, setJustWatered] = useState(false);
  const [name, setName]               = useState('');
  const [inputName, setInputName]     = useState('');
  const [showName, setShowName]       = useState(false);

  useEffect(() => {
    setCheckin(getTodayCheckin());
    setStreak(getStreak());
    setUnread(getUnreadCount());
    const n = getSeniorName();
    if (n) setName(n); else setShowName(true);
  }, []);

  const handleCheckin = (mood: Mood) => {
    addCheckin(mood);
    setCheckin(getTodayCheckin());
    setStreak(getStreak());
    setJustWatered(true);
    setTimeout(() => setJustWatered(false), 2000);
  };

  const handleNameSubmit = () => {
    if (!inputName.trim()) return;
    setSeniorName(inputName.trim());
    setName(inputName.trim());
    setShowName(false);
  };

  /* ── 名前入力画面 ── */
  if (showName) {
    return (
      <div className="h-screen flex flex-col items-center justify-center px-6 bg-amber-50">
        <div className="text-6xl mb-5">🌱</div>
        <h2 className="text-2xl font-bold text-green-900 mb-2">はじめまして！</h2>
        <p className="text-slate-700 mb-7 text-center text-lg">お名前を教えてください</p>
        <input
          type="text" value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          placeholder="例：田中 花子"
          className="w-full border-2 border-green-400 rounded-2xl px-4 py-4 text-xl text-center mb-4 bg-white focus:outline-none focus:border-green-600 text-slate-900"
          onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
        />
        <button onClick={handleNameSubmit}
          className="w-full bg-green-600 text-white rounded-2xl py-4 text-xl font-bold">
          はじめる 🌿
        </button>
      </div>
    );
  }

  /* ── メイン画面（スクロールなし） ── */
  return (
    <div className="h-screen flex flex-col bg-amber-50 overflow-hidden">

      {/* ヘッダー（コンパクト） */}
      <div className="px-5 pt-5 pb-2 flex-shrink-0">
        <p className="text-amber-800 text-sm font-medium">おはようございます</p>
        <h1 className="text-2xl font-bold text-green-900 leading-tight">{name}さん 👋</h1>
      </div>

      {/* 畑（少しコンパクトに） */}
      <div className="px-5 mb-3 flex-shrink-0">
        <Garden streak={streak} justWatered={justWatered} />
      </div>

      {/* チェックイン */}
      <div className="px-5 mb-3 flex-shrink-0">
        <AnimatePresence mode="wait">
          {checkin ? (
            <motion.div key="done"
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
              className="bg-white rounded-2xl px-5 py-3 border-2 border-green-300 flex items-center gap-3">
              <span className="text-2xl">✅</span>
              <div>
                <p className="text-green-900 font-bold">今日のチェックイン完了！</p>
                <p className="text-slate-600 text-sm">
                  {MOOD_OPTIONS.find(m => m.value === checkin.mood)?.emoji}{' '}
                  {MOOD_OPTIONS.find(m => m.value === checkin.mood)?.label}
                  　🔥 {streak}日連続
                </p>
              </div>
            </motion.div>
          ) : (
            <motion.div key="todo" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="bg-white rounded-2xl p-4 border-2 border-amber-300">
              <p className="text-amber-900 font-bold text-base mb-3">今日の気分は？</p>
              <div className="flex gap-2">
                {MOOD_OPTIONS.map((m) => (
                  <motion.button key={m.value} whileTap={{ scale: 0.95 }}
                    onClick={() => handleCheckin(m.value)}
                    className={`flex-1 flex flex-col items-center gap-1 py-3 rounded-xl border-2 font-bold text-sm ${m.color}`}>
                    <span className="text-3xl">{m.emoji}</span>
                    {m.label}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 機能グリッド（2×2） */}
      <div className="px-5 flex-1 min-h-0">
        <div className="grid grid-cols-2 gap-3 h-full max-h-52">
          <Link href="/senior/missions" className="contents">
            <motion.button whileTap={{ scale: 0.96 }}
              className="bg-green-600 text-white rounded-2xl flex flex-col items-center justify-center gap-2 shadow-md">
              <span className="text-4xl">📋</span>
              <p className="font-black text-base">ミッション</p>
              <p className="text-green-200 text-xs">今日のお題</p>
            </motion.button>
          </Link>

          <Link href="/senior/calendar" className="contents">
            <motion.button whileTap={{ scale: 0.96 }}
              className="bg-red-600 text-white rounded-2xl flex flex-col items-center justify-center gap-2 shadow-md">
              <span className="text-4xl">📅</span>
              <p className="font-black text-base">日めくり</p>
              <p className="text-red-200 text-xs">昭和クイズ</p>
            </motion.button>
          </Link>

          <Link href="/senior/post" className="contents">
            <motion.button whileTap={{ scale: 0.96 }}
              className="bg-pink-500 text-white rounded-2xl flex flex-col items-center justify-center gap-2 shadow-md">
              <span className="text-4xl">📮</span>
              <p className="font-black text-base">お手紙</p>
              <p className="text-pink-200 text-xs">写真を送る</p>
            </motion.button>
          </Link>

          <Link href="/senior/messages" className="contents">
            <motion.button whileTap={{ scale: 0.96 }}
              className="bg-amber-500 text-white rounded-2xl flex flex-col items-center justify-center gap-2 shadow-md relative">
              <span className="text-4xl">💌</span>
              <p className="font-black text-base">メッセージ</p>
              <p className="text-amber-200 text-xs">家族から届いた</p>
              {unread > 0 && (
                <span className="absolute top-2 right-3 bg-white text-amber-600 text-xs font-black rounded-full w-6 h-6 flex items-center justify-center">
                  {unread}
                </span>
              )}
            </motion.button>
          </Link>
        </div>
      </div>

      {/* 下部ナビ */}
      <div className="flex-shrink-0 bg-white border-t border-amber-100 flex">
        <div className="flex-1 py-3 flex flex-col items-center gap-1 text-green-800">
          <span className="text-xl">🏡</span>
          <span className="text-xs font-bold">ホーム</span>
        </div>
        <Link href="/" className="flex-1">
          <div className="py-3 flex flex-col items-center gap-1 text-slate-500">
            <span className="text-xl">🔄</span>
            <span className="text-xs font-bold">切り替え</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
