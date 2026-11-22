<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# アプリ一覧（まとめサイト）

このリポジトリには複数のアプリが同居しており、`/apps` がその一覧ページ。
新しいアプリ（ページ）を追加したら、必ず `src/data/apps.ts` の `APPS` に 1 件追加すること（name・emoji・description・tags・addedAt・color）。
各アプリの画面には `/apps` へ戻るリンクを置く。
