'use client';

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

export default function Garden({ streak, justWatered }: GardenProps) {
  const visible = PLANTS.filter((p) => streak >= p.minDay);

  return (
    <div className="relative w-full h-44 rounded-3xl overflow-hidden shadow-inner">
      {/* 空 */}
      <div className="absolute inset-0 bg-gradient-to-b from-sky-300 via-sky-100 to-green-100" />

      {/* 太陽 */}
      <div className="absolute top-3 right-5 text-4xl drop-shadow">☀️</div>

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
            <p className="text-xs text-amber-900 font-medium">
              チェックインすると畑が育ちます
            </p>
          </div>
        ) : (
          <div className="relative h-12">
            {visible.map((plant, i) => (
              <span
                key={i}
                className="absolute text-3xl transition-all duration-500"
                style={{ left: `${plant.x}%`, bottom: 0 }}
              >
                {plant.emoji}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 連続日数バッジ */}
      {streak > 0 && (
        <div className="absolute top-3 left-4 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1 flex items-center gap-1">
          <span className="text-sm">🔥</span>
          <span className="text-sm font-bold text-orange-600">{streak}日連続</span>
        </div>
      )}
    </div>
  );
}
