'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface GardenProps {
  streak: number;
  justWatered?: boolean;
}

const PLANTS = [
  { minDay: 1,  emoji: '🌱', x: 20 },
  { minDay: 3,  emoji: '🌿', x: 45 },
  { minDay: 5,  emoji: '🌻', x: 70 },
  { minDay: 7,  emoji: '🍅', x: 30 },
  { minDay: 10, emoji: '🥕', x: 60 },
  { minDay: 14, emoji: '🌽', x: 15 },
  { minDay: 21, emoji: '🍓', x: 80 },
  { minDay: 30, emoji: '🌸', x: 50 },
];

const MESSAGES = [
  '元気に育ってるよ！🌱',
  '毎日来てくれてありがとう！',
  '一緒に頑張ろうね！💪',
  'あなたの畑です🌻',
  '今日もいい日になるよ！☀️',
];

export default function Garden({ streak, justWatered }: GardenProps) {
  const [bubble, setBubble] = useState<string | null>(null);
  const [tapping, setTapping] = useState(false);

  const visible = PLANTS.filter((p) => streak >= p.minDay);

  const handleTap = () => {
    const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
    setBubble(msg);
    setTapping(true);
    setTimeout(() => setTapping(false), 300);
    setTimeout(() => setBubble(null), 2500);
  };

  return (
    <div className="relative">
      {/* 吹き出し */}
      <AnimatePresence>
        {bubble && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            className="absolute -top-14 left-1/2 -translate-x-1/2 z-10 bg-white border-2 border-green-300 rounded-2xl px-4 py-2 shadow-lg whitespace-nowrap"
          >
            <p className="text-base font-bold text-green-800">{bubble}</p>
            <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-white border-r-2 border-b-2 border-green-300 rotate-45" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 畑本体 */}
      <motion.div
        onClick={handleTap}
        animate={tapping ? { scale: [1, 0.96, 1.03, 1] } : {}}
        transition={{ duration: 0.3, type: 'spring', stiffness: 500 }}
        className="relative w-full h-44 rounded-3xl overflow-hidden shadow-inner cursor-pointer active:brightness-95"
      >
        {/* 空 */}
        <div className="absolute inset-0 bg-gradient-to-b from-sky-300 via-sky-100 to-green-100" />

        {/* 太陽 */}
        <motion.div
          className="absolute top-3 right-5 text-4xl drop-shadow"
          animate={tapping ? { rotate: [0, 15, -10, 0], scale: [1, 1.2, 1] } : {}}
          transition={{ duration: 0.4 }}
        >
          ☀️
        </motion.div>

        {/* 水やりアニメ */}
        {justWatered && (
          <div className="absolute top-6 left-1/2 -translate-x-1/2 flex gap-1 animate-bounce">
            <span className="text-2xl">💧</span>
            <span className="text-2xl">💧</span>
          </div>
        )}

        {/* 地面 */}
        <div className="absolute bottom-0 left-0 right-0 h-14 bg-gradient-to-t from-amber-800 to-amber-600 rounded-b-3xl" />

        {/* 植物エリア */}
        <div className="absolute bottom-8 left-0 right-0 px-4">
          {streak === 0 ? (
            <div className="flex flex-col items-center gap-1">
              <span className="text-4xl">🪨</span>
              <p className="text-xs text-amber-900 font-bold">
                チェックインすると畑が育ちます
              </p>
            </div>
          ) : (
            <div className="relative h-12">
              {visible.map((plant, i) => (
                <motion.span
                  key={i}
                  className="absolute text-3xl"
                  animate={tapping ? { y: [0, -8, 0] } : {}}
                  transition={{ duration: 0.4, delay: i * 0.05 }}
                  style={{ left: `${plant.x}%`, bottom: 0 }}
                >
                  {plant.emoji}
                </motion.span>
              ))}
            </div>
          )}
        </div>

        {/* タップヒント */}
        <div className="absolute bottom-2 right-3">
          <p className="text-xs text-amber-900/60 font-medium">タップ ♪</p>
        </div>

        {/* 連続日数バッジ */}
        {streak > 0 && (
          <div className="absolute top-3 left-4 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1 flex items-center gap-1">
            <span className="text-sm">🔥</span>
            <span className="text-sm font-bold text-orange-600">{streak}日連続</span>
          </div>
        )}
      </motion.div>
    </div>
  );
}
