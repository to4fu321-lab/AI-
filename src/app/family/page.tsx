'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Garden from '@/components/Garden';
import {
  getTodayCheckin, getStreak, getSeniorName,
  getCheckins, getPhotoPosts, getRhythmAnalysis,
  type Checkin, type PhotoPost,
} from '@/lib/storage';

const MOOD_LABEL: Record<string, { emoji: string; label: string; color: string }> = {
  genki:   { emoji: '😄', label: '元気！',   color: 'text-green-800' },
  maama:   { emoji: '🙂', label: 'まあまあ', color: 'text-yellow-800' },
  shindoi: { emoji: '😔', label: 'しんどい', color: 'text-blue-800' },
};

export default function FamilyPage() {
  const [todayCheckin, setTodayCheckin] = useState<ReturnType<typeof getTodayCheckin>>(null);
  const [streak, setStreak]             = useState(0);
  const [seniorName, setSeniorName]     = useState('');
  const [recentCheckins, setRecent]     = useState<Checkin[]>([]);
  const [photos, setPhotos]             = useState<PhotoPost[]>([]);
  const [rhythm, setRhythm]             = useState<ReturnType<typeof getRhythmAnalysis>>(null);

  useEffect(() => {
    setTodayCheckin(getTodayCheckin());
    setStreak(getStreak());
    setSeniorName(getSeniorName() || '家族');
    setRecent(getCheckins().slice(-7).reverse());
    setPhotos(getPhotoPosts());
    setRhythm(getRhythmAnalysis());
  }, []);

  return (
    <div className="flex flex-col min-h-screen pb-24 bg-amber-50">

      {/* ヘッダー */}
      <div className="px-5 pt-8 pb-4 flex-shrink-0">
        <p className="text-amber-800 text-base font-medium">見守りダッシュボード</p>
        <h1 className="text-3xl font-bold text-amber-900">{seniorName}さんの畑 🌿</h1>
      </div>

      {/* 今日の状態 */}
      <div className="px-5 mb-4">
        {todayCheckin ? (
          <div className="bg-green-50 border-2 border-green-400 rounded-3xl p-4">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-3xl">✅</span>
              <p className="text-lg font-bold text-green-900">今日もチェックイン済み</p>
            </div>
            <p className={`text-base font-bold ml-12 ${MOOD_LABEL[todayCheckin.mood]?.color}`}>
              {MOOD_LABEL[todayCheckin.mood]?.emoji} {MOOD_LABEL[todayCheckin.mood]?.label}
              　{todayCheckin.time && <span className="text-slate-500 font-normal text-sm">（{todayCheckin.time}）</span>}
            </p>
          </div>
        ) : (
          <div className="bg-amber-50 border-2 border-amber-400 rounded-3xl p-4">
            <div className="flex items-center gap-3">
              <span className="text-3xl">⏳</span>
              <div>
                <p className="text-lg font-bold text-amber-900">まだチェックインしていません</p>
                <p className="text-sm text-amber-700">電話で声をかけてみましょう</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 🆕 健康シグナル */}
      {rhythm && (
        <div className="px-5 mb-4">
          <h2 className="text-base font-bold text-slate-700 mb-2">🩺 健康シグナル（直近7日）</h2>
          <div className={`rounded-3xl p-4 border-2 ${rhythm.alert ? 'bg-red-50 border-red-400' : 'bg-white border-green-200'}`}>
            {rhythm.alert && (
              <div className="bg-red-500 text-white rounded-xl px-3 py-2 mb-3 flex items-center gap-2">
                <span className="text-xl">⚠️</span>
                <p className="font-bold text-sm">気になるサインがあります。声をかけてみましょう。</p>
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              {/* 起床リズム */}
              <div className="flex flex-col items-center bg-amber-50 rounded-2xl p-3">
                <span className="text-2xl mb-1">🕐</span>
                <p className="text-xs text-slate-600 font-medium text-center">平均チェックイン</p>
                <p className="text-base font-black text-slate-900">{rhythm.avgCheckinTime}</p>
                <p className={`text-xs font-bold mt-1 ${rhythm.rhythmVariation > 180 ? 'text-red-600' : 'text-green-700'}`}>
                  {rhythm.rhythmVariation > 180 ? 'ばらつき大' : '安定'}
                </p>
              </div>
              {/* 気分 */}
              <div className="flex flex-col items-center bg-amber-50 rounded-2xl p-3">
                <span className="text-2xl mb-1">💭</span>
                <p className="text-xs text-slate-600 font-medium text-center">しんどい日</p>
                <p className={`text-base font-black ${rhythm.shindoiCount >= 4 ? 'text-red-600' : 'text-slate-900'}`}>
                  {rhythm.shindoiCount}日 / 7日
                </p>
                <p className={`text-xs font-bold mt-1 ${rhythm.shindoiCount >= 4 ? 'text-red-600' : 'text-green-700'}`}>
                  {rhythm.shindoiCount >= 4 ? '要注意' : '良好'}
                </p>
              </div>
              {/* クイズ */}
              <div className="flex flex-col items-center bg-amber-50 rounded-2xl p-3">
                <span className="text-2xl mb-1">🧠</span>
                <p className="text-xs text-slate-600 font-medium text-center">クイズ正解率</p>
                <p className={`text-base font-black ${rhythm.quizRate !== null && rhythm.quizRate < 40 ? 'text-orange-600' : 'text-slate-900'}`}>
                  {rhythm.quizRate !== null ? `${rhythm.quizRate}%` : '---'}
                </p>
                <p className={`text-xs font-bold mt-1 ${rhythm.quizRate !== null && rhythm.quizRate < 40 ? 'text-orange-600' : 'text-green-700'}`}>
                  {rhythm.quizRate === null ? '記録なし' : rhythm.quizRate < 40 ? '低下傾向' : '良好'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 写真のお手紙 */}
      {photos.length > 0 && (
        <div className="px-5 mb-4">
          <h2 className="text-base font-bold text-slate-700 mb-2">📮 届いたお手紙</h2>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {photos.slice(0, 5).map((photo) => (
              <div key={photo.id} className="flex-shrink-0 w-44 bg-white rounded-2xl overflow-hidden shadow-sm border-2 border-amber-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.imageData} alt="お手紙" className="w-full h-32 object-cover" />
                <div className="p-2">
                  <p className="text-slate-900 font-bold text-sm leading-snug">{photo.caption}</p>
                  <p className="text-slate-500 text-xs mt-1">
                    {new Date(photo.timestamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 畑 */}
      <div className="px-5 mb-4">
        <Garden streak={streak} />
      </div>

      {/* 7日間カレンダー */}
      <div className="px-5 mb-4">
        <div className="bg-white rounded-3xl p-4 shadow-sm border border-amber-100">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xl">🔥</span>
            <p className="text-lg font-bold text-orange-700">{streak}日連続チェックイン</p>
          </div>
          <div className="flex gap-2">
            {[...Array(7)].map((_, i) => {
              const d = new Date();
              d.setDate(d.getDate() - (6 - i));
              const dateStr = d.toISOString().split('T')[0];
              const found = recentCheckins.find((c) => c.date === dateStr);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-base ${found ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                    {found ? MOOD_LABEL[found.mood]?.emoji : '−'}
                  </div>
                  <span className="text-xs text-slate-600 font-medium">{d.getDate()}日</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 下部ナビ */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-amber-100 flex">
        <div className="flex-1 py-4 flex flex-col items-center gap-1 text-amber-800">
          <span className="text-2xl">🏡</span>
          <span className="text-xs font-bold">ダッシュボード</span>
        </div>
        <Link href="/family/messages" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-1 text-amber-700">
            <span className="text-2xl">💌</span>
            <span className="text-xs font-bold">メッセージを送る</span>
          </div>
        </Link>
        <Link href="/" className="flex-1">
          <div className="py-4 flex flex-col items-center gap-1 text-slate-500">
            <span className="text-2xl">⚙️</span>
            <span className="text-xs font-bold">切り替え</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
