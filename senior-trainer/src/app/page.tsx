import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 py-12">
      {/* ロゴ・タイトル */}
      <div className="text-center mb-12">
        <div className="text-7xl mb-4">🌱</div>
        <h1 className="text-4xl font-bold text-green-800 mb-3">つながる畑</h1>
        <p className="text-lg text-amber-800 leading-relaxed">
          毎日の小さな積み重ねが
          <br />
          大切な人との絆を育てます
        </p>
      </div>

      {/* 選択ボタン */}
      <div className="w-full flex flex-col gap-4">
        <Link href="/senior">
          <button className="w-full bg-green-600 hover:bg-green-700 active:bg-green-800 text-white rounded-3xl py-6 px-6 flex items-center gap-4 shadow-lg transition-colors">
            <span className="text-4xl">👴</span>
            <div className="text-left">
              <div className="text-xl font-bold">アプリを使う</div>
              <div className="text-sm text-green-100">シニアの方はこちら</div>
            </div>
            <span className="ml-auto text-2xl">→</span>
          </button>
        </Link>

        <Link href="/family">
          <button className="w-full bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-white rounded-3xl py-6 px-6 flex items-center gap-4 shadow-lg transition-colors">
            <span className="text-4xl">👨‍👩‍👧</span>
            <div className="text-left">
              <div className="text-xl font-bold">家族として見守る</div>
              <div className="text-sm text-amber-100">ご家族の方はこちら</div>
            </div>
            <span className="ml-auto text-2xl">→</span>
          </button>
        </Link>
      </div>

      <p className="mt-10 text-sm text-amber-700 text-center">
        ※ デモ版です。データはこの端末にのみ保存されます。
      </p>
    </div>
  );
}
