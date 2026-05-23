'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import Garden from '@/components/Garden';
import {
  getTodayCheckin, getStreak, getSeniorName,
  getCheckins, getPhotoPosts, getRhythmAnalysis,
  type Checkin, type PhotoPost,
} from '@/lib/storage';

const MOOD_LABEL: Record<string, { emoji: string; label: string; bg: string }> = {
  genki:   { emoji: '😄', label: '元気！',   bg: 'bg-green-500'  },
  maama:   { emoji: '🙂', label: 'まあまあ', bg: 'bg-yellow-500' },
  shindoi: { emoji: '😔', label: 'しんどい', bg: 'bg-blue-500'   },
};

function formatTime(time: string) {
  const [h, m] = time.split(':').map(Number);
  const period = h < 12 ? '午前' : '午後';
  const displayH = h > 12 ? h - 12 : h;
  return `${period}${displayH}:${String(m).padStart(2, '0')}`;
}

export default function FamilyPage() {
  const [todayCheckin, setTodayCheckin] = useState<{ date: string; mood: string; time: string } | null>(null);
  const [streak, setStreak]             = useState(0);
  const [seniorName, setSeniorName]     = useState('');
  const [recentCheckins, setRecent]     = useState<Checkin[]>([]);
  const [photos, setPhotos]             = useState<PhotoPost[]>([]);
  type RhythmData = { avgCheckinTime: string; rhythmVariation: number; shindoiCount: number; quizRate: number | null; alert: boolean } | null;
  const [rhythm, setRhythm]             = useState<RhythmData>(null);

  useEffect(() => {
    (async () => {
      const [c, s, n, ch, ph, r] = await Promise.all([
        getTodayCheckin(),
        getStreak(),
        getSeniorName(),
        getCheckins(),
        getPhotoPosts(),
        getRhythmAnalysis(),
      ]);
      setTodayCheckin(c);
      setStreak(s);
      setSeniorName(n || '家族');
      setRecent(ch.slice(-7));
      setPhotos(ph);
      setRhythm(r);
    })();
  }, []);

  const moodInfo = todayCheckin ? MOOD_LABEL[todayCheckin.mood] : null;

  return (
    <div className="flex flex-col min-h-screen pb-28 bg-slate-50">

      {/* ── ヘッダー ── */}
      <div className="bg-white border-b border-slate-100 px-5 pt-8 pb-4">
        <p className="text-slate-500 text-sm font-medium">見守りダッシュボード</p>
        <h1 className="text-2xl font-black text-slate-900">{seniorName}さんの様子</h1>
      </div>

      {/* ── 今日のステータス（最重要） ── */}
      <div className="px-4 pt-4 pb-2">
        <AnimatePresence mode="wait">
          {todayCheckin && moodInfo ? (
            <motion.div
              key="checked"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden"
            >
              {/* 上部ステータスバー */}
              <div className={`${moodInfo.bg} px-5 py-4 flex items-center gap-3`}>
                <span className="text-4xl">{moodInfo.emoji}</span>
                <div>
                  <p className="text-white font-black text-xl leading-tight">{moodInfo.label}</p>
                  <p className="text-white/80 text-sm">今日のチェックイン済み</p>
                </div>
                {streak > 0 && (
                  <div className="ml-auto bg-white/20 rounded-full px-3 py-1">
                    <span className="text-white font-black text-sm">🔥 {streak}日連続</span>
                  </div>
                )}
              </div>
              {/* チェックイン時刻 */}
              {todayCheckin.time && (
                <div className="px-5 py-3 flex items-center gap-2 border-t border-slate-100">
                  <span className="text-slate-400 text-lg">🕐</span>
                  <span className="text-slate-600 text-sm">
                    <span className="font-bold text-slate-900">{formatTime(todayCheckin.time)}</span>
                    　にアプリを開きました
                  </span>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="unchecked"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-amber-500 rounded-3xl overflow-hidden shadow-md"
            >
              <div className="px-5 py-5 flex items-center gap-4">
                <motion.span
                  animate={{ scale: [1, 1.15, 1] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                  className="text-4xl flex-shrink-0"
                >⏳</motion.span>
                <div className="flex-1">
                  <p className="text-white font-black text-xl leading-tight">まだ起きてないかも？</p>
                  <p className="text-white/80 text-sm mt-0.5">今日のチェックインがありません</p>
                </div>
              </div>
              <Link href="/family/messages">
                <div className="bg-amber-600 px-5 py-3 flex items-center justify-between">
                  <p className="text-white font-bold text-base">💌 声をかけてみましょう</p>
                  <span className="text-white text-xl">→</span>
                </div>
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── 健康シグナル ── */}
      {rhythm && (
        <div className="px-4 pt-3">
          {rhythm.alert && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="bg-red-500 rounded-2xl px-4 py-3 mb-3 flex items-center gap-3 shadow"
            >
              <span className="text-2xl">⚠️</span>
              <div>
                <p className="text-white font-black text-base">気になるサインがあります</p>
                <p className="text-red-100 text-sm">声をかけてみましょう</p>
              </div>
            </motion.div>
          )}

          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-4">
            <p className="text-xs font-bold text-slate-500 mb-3 uppercase tracking-wide">直近7日の健康シグナル</p>
            <div className="grid grid-cols-3 gap-2">
              {/* 生活リズム */}
              <div className="flex flex-col items-center bg-slate-50 rounded-2xl p-3">
                <span className="text-xl mb-1">🕐</span>
                <p className="text-xs text-slate-500 text-center leading-tight mb-1">チェックイン</p>
                <p className="text-sm font-black text-slate-900">{rhythm.avgCheckinTime}</p>
                <span className={`text-xs font-bold mt-1 ${rhythm.rhythmVariation > 180 ? 'text-red-500' : 'text-green-600'}`}>
                  {rhythm.rhythmVariation > 180 ? 'ばらつき大' : '安定'}
                </span>
              </div>
              {/* 気分 */}
              <div className="flex flex-col items-center bg-slate-50 rounded-2xl p-3">
                <span className="text-xl mb-1">💭</span>
                <p className="text-xs text-slate-500 text-center leading-tight mb-1">しんどい日</p>
                <p className={`text-sm font-black ${rhythm.shindoiCount >= 4 ? 'text-red-500' : 'text-slate-900'}`}>
                  {rhythm.shindoiCount} / 7日
                </p>
                <span className={`text-xs font-bold mt-1 ${rhythm.shindoiCount >= 4 ? 'text-red-500' : 'text-green-600'}`}>
                  {rhythm.shindoiCount >= 4 ? '要注意' : '良好'}
                </span>
              </div>
              {/* 脳トレ */}
              <div className="flex flex-col items-center bg-slate-50 rounded-2xl p-3">
                <span className="text-xl mb-1">🧠</span>
                <p className="text-xs text-slate-500 text-center leading-tight mb-1">クイズ正解率</p>
                <p className={`text-sm font-black ${rhythm.quizRate !== null && rhythm.quizRate < 40 ? 'text-orange-500' : 'text-slate-900'}`}>
                  {rhythm.quizRate !== null ? `${rhythm.quizRate}%` : '---'}
                </p>
                <span className={`text-xs font-bold mt-1 ${rhythm.quizRate !== null && rhythm.quizRate < 40 ? 'text-orange-500' : 'text-green-600'}`}>
                  {rhythm.quizRate === null ? '記録なし' : rhythm.quizRate < 40 ? '低下傾向' : '良好'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── 7日間カレンダー ── */}
      <div className="px-4 pt-3">
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-4">
          <p className="text-xs font-bold text-slate-500 mb-3 uppercase tracking-wide">過去7日間のチェックイン</p>
          <div className="flex gap-1.5">
            {[...Array(7)].map((_, i) => {
              const d = new Date();
              d.setDate(d.getDate() - (6 - i));
              const dateStr = d.toISOString().split('T')[0];
              const found = recentCheckins.find((c) => c.date === dateStr);
              const isToday = i === 6;
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className={`w-full aspect-square rounded-xl flex items-center justify-center text-sm
                    ${found ? (MOOD_LABEL[found.mood]?.bg || 'bg-green-500') + ' shadow-sm' : 'bg-slate-100'}
                    ${isToday ? 'ring-2 ring-offset-1 ring-slate-400' : ''}
                  `}>
                    {found
                      ? <span className="text-base">{MOOD_LABEL[found.mood]?.emoji}</span>
                      : <span className="text-slate-300 text-xs font-bold">−</span>
                    }
                  </div>
                  <span className={`text-xs font-medium ${isToday ? 'text-slate-900 font-bold' : 'text-slate-400'}`}>
                    {d.getDate()}日
                  </span>
                </div>
              );
            })}
          </div>
          {streak > 0 && (
            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
              <span>🔥</span>
              <p className="text-sm font-bold text-orange-600">{streak}日連続チェックイン中！</p>
            </div>
          )}
        </div>
      </div>

      {/* ── 畑 ── */}
      <div className="px-4 pt-3">
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-3">
          <p className="text-xs font-bold text-slate-500 mb-2 px-1 uppercase tracking-wide">{seniorName}さんの畑</p>
          <Garden streak={streak} />
        </div>
      </div>

      {/* ── 写真のお手紙 ── */}
      {photos.length > 0 && (
        <div className="pt-3">
          <p className="text-xs font-bold text-slate-500 mb-2 px-5 uppercase tracking-wide">📮 届いたお手紙</p>
          <div className="flex gap-3 px-4 overflow-x-auto pb-1">
            {photos.slice(0, 5).map((photo) => (
              <div key={photo.id}
                className="flex-shrink-0 w-40 bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.image_data} alt="お手紙" className="w-full h-28 object-cover" />
                <div className="p-2.5">
                  <p className="text-slate-900 font-bold text-xs leading-snug line-clamp-2">{photo.caption}</p>
                  <p className="text-slate-400 text-xs mt-1">
                    {new Date(photo.timestamp).toLocaleString('ja-JP', {
                      month: 'numeric', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 下部ナビ ── */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-slate-100 flex shadow-lg">
        <div className="flex-1 py-4 flex flex-col items-center gap-0.5 text-amber-700">
          <span className="text-2xl">🏡</span>
          <span className="text-xs font-bold">ダッシュボード</span>
        </div>
        <Link href="/family/messages" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-0.5 text-slate-500">
            <span className="text-2xl">💌</span>
            <span className="text-xs font-bold">メッセージ</span>
          </div>
        </Link>
        <Link href="/" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-0.5 text-slate-400">
            <span className="text-2xl">🔄</span>
            <span className="text-xs font-bold">切り替え</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
