'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Garden from '@/components/Garden';
import {
  getTodayCheckin,
  getStreak,
  getSeniorName,
  getCheckins,
  getPhotoPosts,
  type Checkin,
  type PhotoPost,
} from '@/lib/storage';

const MOOD_LABEL: Record<string, { emoji: string; label: string; color: string }> = {
  genki:   { emoji: '😄', label: '元気！',   color: 'text-green-800' },
  maama:   { emoji: '🙂', label: 'まあまあ', color: 'text-yellow-800' },
  shindoi: { emoji: '😔', label: 'しんどい', color: 'text-blue-800' },
};

export default function FamilyPage() {
  const [todayCheckin, setTodayCheckin] = useState<ReturnType<typeof getTodayCheckin>>(null);
  const [streak, setStreak] = useState(0);
  const [seniorName, setSeniorName] = useState('');
  const [recentCheckins, setRecentCheckins] = useState<Checkin[]>([]);
  const [photos, setPhotos] = useState<PhotoPost[]>([]);

  useEffect(() => {
    setTodayCheckin(getTodayCheckin());
    setStreak(getStreak());
    setSeniorName(getSeniorName() || '家族');
    setRecentCheckins(getCheckins().slice(-7).reverse());
    setPhotos(getPhotoPosts());
  }, []);

  return (
    <div className="flex flex-col min-h-screen pb-24">
      {/* ヘッダー */}
      <div className="px-5 pt-8 pb-4">
        <p className="text-amber-800 text-base font-medium">見守りダッシュボード</p>
        <h1 className="text-3xl font-bold text-amber-900">{seniorName}さんの畑 🌿</h1>
      </div>

      {/* 今日の状態 */}
      <div className="px-5 mb-5">
        {todayCheckin ? (
          <div className="bg-green-50 border-2 border-green-400 rounded-3xl p-5">
            <div className="flex items-center gap-3 mb-1">
              <span className="text-3xl">✅</span>
              <p className="text-xl font-bold text-green-900">今日もチェックイン済み</p>
            </div>
            <p className={`text-lg font-bold ml-12 ${MOOD_LABEL[todayCheckin.mood]?.color}`}>
              {MOOD_LABEL[todayCheckin.mood]?.emoji} {MOOD_LABEL[todayCheckin.mood]?.label}
            </p>
          </div>
        ) : (
          <div className="bg-amber-50 border-2 border-amber-400 rounded-3xl p-5">
            <div className="flex items-center gap-3">
              <span className="text-3xl">⏳</span>
              <div>
                <p className="text-xl font-bold text-amber-900">まだチェックインしていません</p>
                <p className="text-base text-amber-700">電話で声をかけてみましょう</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 写真のお手紙 */}
      {photos.length > 0 && (
        <div className="px-5 mb-5">
          <h2 className="text-lg font-bold text-amber-900 mb-3">📮 届いたお手紙</h2>
          <div className="flex flex-col gap-4">
            {photos.slice(0, 3).map((photo) => (
              <div key={photo.id} className="bg-white rounded-3xl overflow-hidden shadow-sm border-2 border-amber-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.imageData} alt="お手紙の写真" className="w-full object-cover max-h-56" />
                <div className="p-4">
                  <p className="text-slate-900 font-bold text-lg">{photo.caption}</p>
                  <p className="text-slate-500 text-sm mt-1">
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

      {/* 畑の状態 */}
      <div className="px-5 mb-5">
        <Garden streak={streak} />
      </div>

      {/* 連続記録 */}
      <div className="px-5 mb-5">
        <div className="bg-white rounded-3xl p-5 shadow-sm border border-amber-100">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">🔥</span>
            <p className="text-xl font-bold text-orange-700">{streak}日連続チェックイン</p>
          </div>
          <p className="text-slate-600 mb-3 font-medium">直近7日間の記録</p>
          <div className="flex gap-2">
            {[...Array(7)].map((_, i) => {
              const d = new Date();
              d.setDate(d.getDate() - (6 - i));
              const dateStr = d.toISOString().split('T')[0];
              const found = recentCheckins.find((c) => c.date === dateStr);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-base ${
                    found ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
                  }`}>
                    {found ? MOOD_LABEL[found.mood]?.emoji : '−'}
                  </div>
                  <span className="text-xs text-slate-600 font-medium">{d.getDate()}日</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 下部ナビゲーション */}
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
