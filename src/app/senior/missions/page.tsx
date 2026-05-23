'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';

const MISSIONS = [
  { icon: '🚶', label: '外の空気を5分吸う',      category: '体を動かす', color: 'border-green-400 bg-green-50' },
  { icon: '💬', label: '誰かに一言話しかける',    category: 'つながる',   color: 'border-amber-400 bg-amber-50' },
  { icon: '🧠', label: '今日のニュースを1つ読む', category: '頭を使う',   color: 'border-blue-400  bg-blue-50'  },
];

export default function MissionsPage() {
  const [done, setDone] = useState([false, false, false]);

  const toggle = (i: number) => setDone((p) => { const n = [...p]; n[i] = !n[i]; return n; });
  const allDone = done.every(Boolean);

  return (
    <div className="h-screen flex flex-col bg-amber-50 overflow-hidden">

      {/* ヘッダー */}
      <div className="flex items-center gap-3 px-5 pt-7 pb-4 flex-shrink-0">
        <Link href="/senior" className="text-3xl text-amber-800 leading-none">←</Link>
        <h1 className="text-xl font-bold text-amber-900">📋 今日のミッション</h1>
      </div>

      {/* ミッションカード */}
      <div className="flex-1 px-5 flex flex-col gap-4 justify-center min-h-0">
        {MISSIONS.map((m, i) => (
          <motion.button key={i} whileTap={{ scale: 0.97 }} onClick={() => toggle(i)}
            className={`w-full rounded-2xl p-5 border-2 flex items-center gap-4 transition-all ${
              done[i] ? 'bg-green-100 border-green-500' : `${m.color}`
            }`}>
            <span className="text-5xl flex-shrink-0">{m.icon}</span>
            <div className="flex-1 text-left">
              <p className={`font-bold text-slate-900 text-lg leading-snug ${done[i] ? 'line-through text-slate-400' : ''}`}>
                {m.label}
              </p>
              <p className="text-amber-700 font-medium text-sm mt-1">{m.category}</p>
            </div>
            <AnimatePresence>
              {done[i] && (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                  className="text-3xl flex-shrink-0">✅</motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        ))}

        {/* 全完了バナー */}
        <AnimatePresence>
          {allDone && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              className="bg-green-500 rounded-2xl p-4 text-center shadow-lg">
              <p className="text-white font-black text-xl">🎉 全部できた！すごい！</p>
              <p className="text-green-100 mt-1">畑の作物が元気に育ちます 🌻</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 戻るボタン */}
      <div className="flex-shrink-0 px-5 py-4">
        <Link href="/senior">
          <button className="w-full bg-green-600 text-white rounded-2xl py-4 text-xl font-bold">
            🏡 ホームに戻る
          </button>
        </Link>
      </div>
    </div>
  );
}
