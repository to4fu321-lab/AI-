This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 動画修復アプリ（`/repair`）

撮影の中断や転送の失敗で再生できなくなった MP4 / MOV を、ブラウザだけで修復するページです。iPhone の Safari から使えます（ホーム画面に追加可能）。

- **対象**: 索引（`moov`）が書き込まれずに終わったファイル。映像は H.264 / HEVC、音声は AAC。
- **端末内で完結**: 動画はアップロードされません。再エンコードもせず、元ファイルの映像・音声データに新しい索引を付け直すだけなので、数 GB のファイルでも扱えます。
- **参考動画あり**: 同じカメラ・同じ設定で撮った正常な動画から再生設定を引き継ぎます（H.264 / HEVC）。
- **参考動画なし**: H.264 に限り、スライスヘッダの解析と試行デコード（ffmpeg の WebAssembly 版）で再生設定を割り出します。

仕組みの本体は `src/lib/repair/` にあります。

| ファイル | 役割 |
| --- | --- |
| `scan.ts` | 生データから映像フレーム（NAL）と音声フレーム（AAC）を検出 |
| `aac.ts` | AAC のビットストリーム構文を追ってフレーム境界を特定 |
| `h264.ts` / `hevc.ts` | SPS / PPS / スライスヘッダの解析と生成 |
| `estimate.ts` | 参考動画なしの場合の SPS / PPS 推定 |
| `mp4.ts` | 参考動画の読み取りと、新しい `moov` の書き出し |

コマンドラインからも試せます（システムの `ffmpeg` が必要）。

```bash
npx tsx scripts/repair-cli.ts 壊れた動画.mp4 出力.mp4 [参考動画.mp4]
```

### 既知の制限

- HEVC は参考動画が必須です。
- AAC 以外の音声（PCM など）は復元されず、映像のみになります。
- 参考動画なしの場合、x264 以外のエンコーダで `pic_init_qp` が 26 以外の動画は色や明るさが崩れることがあります（参考動画を指定すれば解決します）。
- 可変フレームレートの動画は一定のフレームレートとして書き出されます。
