export function Footer() {
  return (
    <footer className="mt-12 border-t border-neutral-200 bg-white py-8 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-7xl px-4 text-center text-xs text-neutral-400 sm:px-6 lg:px-8">
        <p className="font-black text-neutral-500 dark:text-neutral-300">
          Buzz<span className="text-fuchsia-500">Tube</span>
        </p>
        <p className="mt-2">
          掲載動画の著作権は各権利者に帰属します。本サイトは公式の埋め込み機能（YouTube
          iframe / X blockquote）のみを使用し、動画ファイルを保存・配信していません。
        </p>
        <p className="mt-4">© 2026 BuzzTube. All rights reserved.</p>
      </div>
    </footer>
  );
}
