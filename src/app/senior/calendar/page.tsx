'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { getTodayQuiz, getTodayDateLabel, type Quiz } from '@/lib/quizData';
import { saveQuizResult } from '@/lib/storage';

type Phase = 'calendar' | 'quiz' | 'result';

export default function CalendarPage() {
  const [phase, setPhase] = useState<Phase>('calendar');
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [dateLabel, setDateLabel] = useState<ReturnType<typeof getTodayDateLabel> | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    setQuiz(getTodayQuiz());
    setDateLabel(getTodayDateLabel());
  }, []);

  const handleFlip = () => {
    setFlipped(true);
    setTimeout(() => setPhase('quiz'), 400);
  };

  const handleAnswer = (i: number) => {
    if (selected !== null || !quiz) return;
    setSelected(i);
    saveQuizResult(i === quiz.answer);
    setTimeout(() => setPhase('result'), 800);
  };

  if (!quiz || !dateLabel) return null;

  const isCorrect = selected === quiz.answer;

  return (
    <div className="min-h-screen bg-amber-50 flex flex-col">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 px-5 pt-8 pb-4">
        <Link href="/senior" className="text-3xl text-amber-800">←</Link>
        <h1 className="text-xl font-bold text-amber-900">📅 今日の日めくり</h1>
      </div>

      <div className="flex-1 px-5 flex flex-col items-center justify-start gap-6 pb-10">

        {/* ── カレンダー ── */}
        <AnimatePresence mode="wait">
          {phase === 'calendar' && (
            <motion.div
              key="calendar"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, rotateX: -90, scale: 0.9 }}
              transition={{ duration: 0.4 }}
              className="w-full"
            >
              {/* 日めくりカード */}
              <motion.button
                onClick={handleFlip}
                whileTap={{ scale: 0.97 }}
                className="w-full bg-white rounded-3xl shadow-xl border-4 border-amber-200 overflow-hidden"
              >
                {/* カード上部（赤いリング風） */}
                <div className="bg-red-600 py-3 flex justify-center gap-4">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="w-3 h-6 bg-red-800 rounded-full" />
                  ))}
                </div>

                {/* 日付 */}
                <div className="py-8 px-6 text-center border-b-4 border-dashed border-amber-200">
                  <div className="flex items-end justify-center gap-2 mb-2">
                    <span className="text-7xl font-black text-red-600 leading-none">{dateLabel.day}</span>
                    <div className="flex flex-col items-start mb-2">
                      <span className="text-2xl font-bold text-slate-700">{dateLabel.month}月</span>
                      <span className="text-xl font-bold text-amber-700">（{dateLabel.weekday}）</span>
                    </div>
                  </div>
                  <p className="text-slate-600 font-medium">令和{new Date().getFullYear() - 2018}年</p>
                </div>

                {/* 今日の一言 */}
                <div className="py-6 px-6 bg-amber-50 text-center">
                  <p className="text-slate-800 font-bold text-lg mb-1">☀️ 今日も良い一日を！</p>
                  <p className="text-amber-700 font-medium">{quiz.era}</p>
                </div>

                {/* タップ促し */}
                <div className="bg-amber-100 py-4 text-center">
                  <motion.p
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="text-amber-900 font-bold text-lg"
                  >
                    📖 タップしてめくる！
                  </motion.p>
                </div>
              </motion.button>
            </motion.div>
          )}

          {/* ── クイズ ── */}
          {phase === 'quiz' && (
            <motion.div
              key="quiz"
              initial={{ opacity: 0, rotateX: 90, scale: 0.9 }}
              animate={{ opacity: 1, rotateX: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="w-full flex flex-col gap-5"
            >
              {/* 問題カード */}
              <div className="bg-white rounded-3xl shadow-lg border-2 border-amber-200 p-6">
                <div className="inline-block bg-red-600 text-white text-sm font-bold px-3 py-1 rounded-full mb-4">
                  {quiz.era} のクイズ
                </div>
                <p className="text-slate-900 font-bold text-xl leading-relaxed">{quiz.question}</p>
              </div>

              {/* 選択肢 */}
              <div className="flex flex-col gap-3">
                {quiz.choices.map((choice, i) => (
                  <motion.button
                    key={i}
                    onClick={() => handleAnswer(i)}
                    whileTap={{ scale: 0.97 }}
                    animate={
                      selected !== null
                        ? i === quiz.answer
                          ? { backgroundColor: '#dcfce7', borderColor: '#16a34a', scale: 1.02 }
                          : i === selected && selected !== quiz.answer
                          ? { backgroundColor: '#fee2e2', borderColor: '#dc2626' }
                          : {}
                        : {}
                    }
                    className={`w-full text-left rounded-2xl px-5 py-5 border-2 font-bold text-lg transition-colors
                      ${selected === null
                        ? 'bg-white border-amber-200 text-slate-900 active:bg-amber-50'
                        : 'border-amber-200 bg-white text-slate-900'
                      }`}
                  >
                    <span className="text-amber-700 mr-3">
                      {['①', '②', '③'][i]}
                    </span>
                    {choice}
                    {selected !== null && i === quiz.answer && (
                      <span className="ml-2">✅</span>
                    )}
                    {selected !== null && i === selected && selected !== quiz.answer && (
                      <span className="ml-2">❌</span>
                    )}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── 結果 ── */}
          {phase === 'result' && (
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className="w-full flex flex-col gap-5"
            >
              {/* 正解・不正解バナー */}
              <div className={`rounded-3xl p-6 text-center shadow-lg ${isCorrect ? 'bg-green-500' : 'bg-amber-500'}`}>
                <motion.div
                  animate={{ rotate: isCorrect ? [0, -10, 10, -5, 0] : [0, 5, -5, 0] }}
                  transition={{ duration: 0.5 }}
                  className="text-6xl mb-3"
                >
                  {isCorrect ? '🎉' : '😊'}
                </motion.div>
                <p className="text-white font-black text-3xl mb-1">
                  {isCorrect ? '正解！' : 'ざんねん…'}
                </p>
                <p className="text-white/90 font-bold text-lg">
                  {isCorrect ? '素晴らしい記憶力です！' : `正解は「${quiz.choices[quiz.answer]}」でした`}
                </p>
              </div>

              {/* 解説 */}
              <div className="bg-white rounded-3xl p-5 shadow-sm border-2 border-amber-200">
                <p className="text-amber-800 font-bold text-base mb-2">💡 豆知識</p>
                <p className="text-slate-800 text-base leading-relaxed">{quiz.explanation}</p>
              </div>

              {isCorrect && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-green-50 border-2 border-green-300 rounded-3xl p-4 text-center"
                >
                  <p className="text-green-800 font-bold">💧 正解したので畑に水をあげました！</p>
                </motion.div>
              )}

              {/* ホームへ戻る */}
              <Link href="/senior">
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  className="w-full bg-green-600 text-white rounded-2xl py-5 text-xl font-bold shadow-lg"
                >
                  🏡 畑に戻る
                </motion.button>
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
