'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { addPhotoPost, compressImage } from '@/lib/storage';

const CAPTIONS = [
  { emoji: '😊', text: '元気にしています' },
  { emoji: '🚶', text: '今日お散歩してきました' },
  { emoji: '🍱', text: '今日作ったごはんです' },
  { emoji: '🌸', text: '綺麗なお花を見つけました' },
  { emoji: '☀️', text: '今日の空がきれいです' },
  { emoji: '🌿', text: '近所の自然が気持ちいい' },
  { emoji: '😴', text: 'ゆっくり休んでいます' },
  { emoji: '❤️', text: 'いつもありがとう' },
];

type Phase = 'select' | 'caption' | 'done';

export default function PostPage() {
  const [phase, setPhase] = useState<Phase>('select');
  const [preview, setPreview] = useState<string | null>(null);
  const [compressed, setCompressed] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [customText, setCustomText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const data = await compressImage(file);
    setPreview(data);
    setCompressed(data);
    setPhase('caption');
  };

  const handleSend = async () => {
    if (!compressed) return;
    const finalCaption = customText.trim() || caption;
    if (!finalCaption) return;
    setSending(true);
    await new Promise((r) => setTimeout(r, 800));
    addPhotoPost(compressed, finalCaption);
    setSending(false);
    setPhase('done');
  };

  return (
    <div className="min-h-screen bg-amber-50 flex flex-col">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 px-5 pt-8 pb-4">
        <Link href="/senior" className="text-3xl text-amber-800">←</Link>
        <h1 className="text-xl font-bold text-amber-900">📮 お手紙ポスト</h1>
      </div>

      <div className="flex-1 px-5 pb-10">
        <AnimatePresence mode="wait">

          {/* ── 写真選択 ── */}
          {phase === 'select' && (
            <motion.div
              key="select"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-5"
            >
              <div className="bg-white rounded-3xl p-6 shadow-sm border-2 border-amber-200 text-center">
                <p className="text-slate-800 font-bold text-lg mb-1">写真を撮って家族に送ろう 📸</p>
                <p className="text-slate-600">お散歩中の花・今日のごはん・空の景色…なんでもOK！</p>
              </div>

              {/* カメラボタン */}
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => inputRef.current?.click()}
                className="w-full bg-amber-500 text-white rounded-3xl py-8 flex flex-col items-center gap-3 shadow-lg"
              >
                <span className="text-6xl">📷</span>
                <p className="text-2xl font-black">写真を撮る</p>
                <p className="text-amber-100 font-medium">カメラが開きます</p>
              </motion.button>

              {/* ギャラリーから選ぶ */}
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => {
                  if (inputRef.current) {
                    inputRef.current.removeAttribute('capture');
                    inputRef.current.click();
                  }
                }}
                className="w-full bg-white border-2 border-amber-300 text-amber-800 rounded-3xl py-6 flex flex-col items-center gap-2 shadow-sm"
              >
                <span className="text-4xl">🖼️</span>
                <p className="text-xl font-bold">アルバムから選ぶ</p>
              </motion.button>

              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleFileChange}
              />
            </motion.div>
          )}

          {/* ── 定型文選択 ── */}
          {phase === 'caption' && preview && (
            <motion.div
              key="caption"
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-4"
            >
              {/* 写真プレビュー */}
              <div className="rounded-3xl overflow-hidden shadow-lg border-4 border-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview} alt="プレビュー" className="w-full object-cover max-h-64" />
              </div>

              <p className="text-slate-800 font-bold text-lg text-center">一言メッセージを選んでね 💬</p>

              {/* 定型文ボタン */}
              <div className="grid grid-cols-2 gap-3">
                {CAPTIONS.map((c) => (
                  <motion.button
                    key={c.text}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => setCaption(c.text)}
                    className={`rounded-2xl py-4 px-3 border-2 font-bold text-sm text-left transition-colors ${
                      caption === c.text
                        ? 'bg-amber-100 border-amber-500 text-amber-900'
                        : 'bg-white border-amber-200 text-slate-800'
                    }`}
                  >
                    <span className="text-2xl block mb-1">{c.emoji}</span>
                    {c.text}
                    {caption === c.text && <span className="ml-1">✅</span>}
                  </motion.button>
                ))}
              </div>

              {/* 自由入力 */}
              <div>
                <p className="text-slate-700 font-bold mb-2">または自分で書く：</p>
                <input
                  type="text"
                  value={customText}
                  onChange={(e) => { setCustomText(e.target.value); setCaption(''); }}
                  placeholder="例：今日は天気が良かったよ"
                  className="w-full border-2 border-amber-200 rounded-2xl px-4 py-4 text-base bg-white focus:outline-none focus:border-amber-400 text-slate-900"
                />
              </div>

              {/* 送信ボタン */}
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={handleSend}
                disabled={!caption && !customText.trim()}
                className={`w-full rounded-2xl py-6 text-xl font-black shadow-lg transition-colors ${
                  caption || customText.trim()
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-200 text-gray-400'
                }`}
              >
                {sending ? '送っています… 📮' : '📮 家族に送る！'}
              </motion.button>
            </motion.div>
          )}

          {/* ── 完了 ── */}
          {phase === 'done' && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="flex flex-col items-center gap-6 pt-8"
            >
              <motion.div
                animate={{ y: [0, -15, 0] }}
                transition={{ repeat: 2, duration: 0.5 }}
                className="text-8xl"
              >
                📮
              </motion.div>

              <div className="bg-white rounded-3xl p-6 shadow-lg border-2 border-green-300 text-center w-full">
                <p className="text-green-800 font-black text-2xl mb-2">送れました！</p>
                <p className="text-slate-700 text-base">家族のダッシュボードに届きました。<br />返事が来るのを楽しみにしてね 🌸</p>
              </div>

              <Link href="/senior" className="w-full">
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  className="w-full bg-green-600 text-white rounded-2xl py-5 text-xl font-bold"
                >
                  🏡 畑に戻る
                </motion.button>
              </Link>

              <button
                onClick={() => { setPhase('select'); setPreview(null); setCaption(''); setCustomText(''); }}
                className="text-amber-700 font-bold text-lg underline"
              >
                もう1枚送る 📷
              </button>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </div>
  );
}
