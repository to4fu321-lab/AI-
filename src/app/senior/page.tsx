'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import Garden from '@/components/Garden';
import {
  getTodayCheckin, addCheckin, getStreak,
  getUnreadCount, getSeniorName, setSeniorName,
  getTodayQuizDone, type Mood,
} from '@/lib/storage';

const MOOD_OPTIONS: { value: Mood; emoji: string; label: string; color: string }[] = [
  { value: 'genki',   emoji: '😄', label: '元気！',   color: 'bg-green-100 border-green-500 text-green-900' },
  { value: 'maama',   emoji: '🙂', label: 'まあまあ', color: 'bg-yellow-100 border-yellow-500 text-yellow-900' },
  { value: 'shindoi', emoji: '😔', label: 'しんどい', color: 'bg-blue-100 border-blue-500 text-blue-900' },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 10) return 'おはようございます ☀️';
  if (h < 17) return 'こんにちは 🌤️';
  return 'こんばんは 🌙';
}

type GuideType = 'checkin' | 'messages' | 'quiz' | 'photo' | 'done';

function getGuide(checkin: boolean, unread: number, quizDone: boolean): GuideType {
  if (!checkin) return 'checkin';
  if (unread > 0) return 'messages';
  if (!quizDone) return 'quiz';
  return 'photo';
}

export default function SeniorPage() {
  const [checkin, setCheckin]         = useState<ReturnType<typeof getTodayCheckin>>(null);
  const [streak, setStreak]           = useState(0);
  const [unread, setUnread]           = useState(0);
  const [quizDone, setQuizDone]       = useState(false);
  const [justWatered, setJustWatered] = useState(false);
  const [name, setName]               = useState('');
  const [inputName, setInputName]     = useState('');
  const [showName, setShowName]       = useState(false);

  useEffect(() => {
    const c = getTodayCheckin();
    setCheckin(c);
    setStreak(getStreak());
    setUnread(getUnreadCount());
    setQuizDone(getTodayQuizDone());
    const n = getSeniorName();
    if (n) setName(n); else setShowName(true);
  }, []);

  const handleCheckin = (mood: Mood) => {
    addCheckin(mood);
    const c = getTodayCheckin();
    setCheckin(c);
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

  /* ── 名前入力 ── */
  if (showName) {
    return (
      <div className="h-screen flex flex-col items-center justify-center px-6 bg-amber-50">
        <div className="text-6xl mb-5">🌱</div>
        <h2 className="text-2xl font-bold text-green-900 mb-2">はじめまして！</h2>
        <p className="text-slate-700 mb-7 text-center text-lg">お名前を教えてください</p>
        <input type="text" value={inputName} onChange={(e) => setInputName(e.target.value)}
          placeholder="例：田中 花子"
          className="w-full border-2 border-green-400 rounded-2xl px-4 py-4 text-xl text-center mb-4 bg-white focus:outline-none focus:border-green-600 text-slate-900"
          onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()} />
        <button onClick={handleNameSubmit}
          className="w-full bg-green-600 text-white rounded-2xl py-5 text-xl font-bold shadow-lg">
          はじめる 🌿
        </button>
      </div>
    );
  }

  const guide = getGuide(!!checkin, unread, quizDone);

  /* ── メイン ── */
  return (
    <div className="h-screen flex flex-col bg-gradient-to-b from-sky-50 to-amber-50 overflow-hidden">

      {/* ヘッダー */}
      <div className="px-5 pt-5 pb-2 flex-shrink-0 flex items-center justify-between">
        <div>
          <p className="text-amber-800 text-sm font-medium">{getGreeting()}</p>
          <h1 className="text-2xl font-black text-green-900 leading-tight">{name}さん</h1>
        </div>
        {streak > 0 && (
          <div className="bg-orange-100 border border-orange-300 rounded-full px-3 py-1 flex items-center gap-1">
            <span>🔥</span>
            <span className="text-orange-700 font-black text-sm">{streak}日連続</span>
          </div>
        )}
      </div>

      {/* 畑 */}
      <div className="px-5 mb-3 flex-shrink-0">
        <Garden streak={streak} justWatered={justWatered} />
      </div>

      {/* ★ ガイドカード（今日のおすすめ） */}
      <div className="px-5 mb-3 flex-shrink-0">
        <AnimatePresence mode="wait">

          {/* チェックインがまだ */}
          {guide === 'checkin' && (
            <motion.div key="checkin"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-3xl border-2 border-green-400 shadow-lg overflow-hidden">
              <div className="bg-green-500 px-5 py-3 flex items-center gap-2">
                <motion.span animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1.5 }}
                  className="text-2xl">👆</motion.span>
                <p className="text-white font-black text-lg">まず今日の気分を教えてください</p>
              </div>
              <div className="flex gap-2 p-4">
                {MOOD_OPTIONS.map((m) => (
                  <motion.button key={m.value} whileTap={{ scale: 0.93 }}
                    onClick={() => handleCheckin(m.value)}
                    className={`flex-1 flex flex-col items-center gap-1 py-4 rounded-2xl border-2 font-bold text-sm ${m.color}`}>
                    <span className="text-4xl">{m.emoji}</span>
                    {m.label}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          {/* 家族からメッセージあり */}
          {guide === 'messages' && (
            <Link href="/senior/messages">
              <motion.div key="messages"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                whileTap={{ scale: 0.97 }}
                className="bg-white rounded-3xl border-2 border-amber-400 shadow-lg overflow-hidden cursor-pointer">
                <div className="bg-amber-500 px-5 py-3 flex items-center gap-2">
                  <motion.span animate={{ rotate: [-5, 5, -5] }} transition={{ repeat: Infinity, duration: 0.8 }}
                    className="text-2xl">💌</motion.span>
                  <p className="text-white font-black text-lg">家族からメッセージが届いています！</p>
                  <span className="ml-auto bg-white text-amber-600 font-black text-sm rounded-full w-7 h-7 flex items-center justify-center">{unread}</span>
                </div>
                <div className="px-5 py-4 flex items-center justify-between">
                  <p className="text-slate-700 font-bold text-base">タップして読みましょう 👇</p>
                  <span className="text-2xl text-amber-500">→</span>
                </div>
              </motion.div>
            </Link>
          )}

          {/* クイズがまだ */}
          {guide === 'quiz' && (
            <Link href="/senior/calendar">
              <motion.div key="quiz"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                whileTap={{ scale: 0.97 }}
                className="bg-white rounded-3xl border-2 border-red-400 shadow-lg overflow-hidden cursor-pointer">
                <div className="bg-red-600 px-5 py-3 flex items-center gap-2">
                  <span className="text-2xl">📅</span>
                  <p className="text-white font-black text-lg">今日の昭和クイズが届いています！</p>
                </div>
                <div className="px-5 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-slate-800 font-bold text-base">カレンダーをめくってみましょう</p>
                    <p className="text-slate-500 text-sm">脳トレにもなります 🧠</p>
                  </div>
                  <motion.span animate={{ x: [0, 4, 0] }} transition={{ repeat: Infinity, duration: 1 }}
                    className="text-2xl text-red-500">→</motion.span>
                </div>
              </motion.div>
            </Link>
          )}

          {/* 全部済み → 写真を勧める */}
          {guide === 'photo' && (
            <Link href="/senior/post">
              <motion.div key="photo"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                whileTap={{ scale: 0.97 }}
                className="bg-white rounded-3xl border-2 border-pink-400 shadow-lg overflow-hidden cursor-pointer">
                <div className="bg-pink-500 px-5 py-3 flex items-center gap-2">
                  <span className="text-2xl">📷</span>
                  <p className="text-white font-black text-lg">今日の思い出を家族に送ろう！</p>
                </div>
                <div className="px-5 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-slate-800 font-bold text-base">お散歩・ごはん・お花…なんでもOK</p>
                    <p className="text-slate-500 text-sm">写真1枚で家族が喜びます 🌸</p>
                  </div>
                  <span className="text-2xl text-pink-500">→</span>
                </div>
              </motion.div>
            </Link>
          )}

        </AnimatePresence>
      </div>

      {/* サブメニュー（横並び小ボタン） */}
      <div className="px-5 flex-shrink-0">
        <p className="text-slate-500 text-xs font-bold mb-2 px-1">ほかにできること</p>
        <div className="flex gap-3">
          {[
            { href: '/senior/missions', emoji: '📋', label: 'ミッション', color: 'bg-green-100 border-green-300 text-green-900' },
            { href: '/senior/calendar', emoji: '📅', label: '日めくり',   color: 'bg-red-100   border-red-300   text-red-900'   },
            { href: '/senior/post',     emoji: '📮', label: 'お手紙',     color: 'bg-pink-100  border-pink-300  text-pink-900'  },
            { href: '/senior/messages', emoji: '💌', label: 'メッセージ', color: 'bg-amber-100 border-amber-300 text-amber-900',
              badge: unread > 0 ? unread : undefined },
          ].map((item) => (
            <Link key={item.href} href={item.href} className="flex-1">
              <motion.div whileTap={{ scale: 0.94 }}
                className={`relative rounded-2xl border-2 py-3 flex flex-col items-center gap-1 ${item.color}`}>
                <span className="text-2xl">{item.emoji}</span>
                <span className="text-xs font-bold">{item.label}</span>
                {item.badge && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-black rounded-full w-5 h-5 flex items-center justify-center">
                    {item.badge}
                  </span>
                )}
              </motion.div>
            </Link>
          ))}
        </div>
      </div>

      {/* 下部ナビ */}
      <div className="flex-shrink-0 mt-auto bg-white border-t border-amber-100 flex">
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
