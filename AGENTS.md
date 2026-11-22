<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# アプリ一覧（まとめサイト）

このリポジトリには複数のアプリが同居しており、`/apps` がその一覧ページ。
新しいアプリ（ページ）を追加したら、必ず `src/data/apps.ts` の `APPS` に 1 件追加すること（slug・name・emoji・description・tags・addedAt・color・access・paths）。
`access` は public（誰でも）/ sale（個人販売・アプリごとのパスワード `PASSWORD_APP_<SLUG>`）/ ezoshirube（エゾシルベ用・`PASSWORD_EZOSHIRUBE`）/ private（自分だけ・`PASSWORD_PRIVATE`）。
鍵付きアプリは `paths` に画面と API の両方の URL 先頭を書く（`src/proxy.ts` が自動で守る）。API の中でも `guardApi()` で二重チェックする。
sale のアプリを足したら、Vercel の環境変数に `PASSWORD_APP_<SLUG>` を登録しないと誰も開けない。
各アプリの画面には `/apps` へ戻るリンクを置く。
