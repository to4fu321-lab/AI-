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

まずファイルを診断して壊れ方を特定し、それに合った方法で修復します。動画はアップロードされず、再エンコードもしません（元ファイルのデータに新しい索引を付け直すだけなので、数 GB のファイルでも扱えます）。

| 壊れ方 | 修復方法 |
| --- | --- |
| 索引（`moov`）がない（録画・保存の中断） | 生データから映像・音声フレームを検出して索引を作り直す |
| 途中で切れている（ダウンロード・コピーの中断） | 残っている索引を使い、実在するサンプルだけで作り直す |
| 一部がゼロやゴミで上書きされている | 壊れたフレームと、それに依存するフレームを次のキーフレームまで除去。時間軸は保つ |
| 先頭（ヘッダ）が壊れている | ファイル内から `moov` を探し出して利用する |
| データ位置がずれている（先頭側のバイト欠落） | ずれ量を割り出して索引を補正する |
| 索引が壊れている | 残った設定情報を使い、生データから作り直す |
| MP4・MOV ではない／中身がすべてゼロ | 修復できない理由を表示する |

索引が残っている場合は映像・音声の形式を問いません（PCM 音声なども可）。索引がない場合の対象は H.264 / HEVC の映像と AAC 音声で、次のどちらかで再生設定を得ます。

- **参考動画あり**: 同じカメラ・同じ設定で撮った正常な動画から再生設定を引き継ぎます（H.264 / HEVC）。
- **参考動画なし**: 映像に再生設定が埋め込まれていればそれを使います。H.264 で埋め込まれていない場合は、スライスヘッダの解析と試行デコード（ffmpeg の WebAssembly 版）で再生設定を割り出します。

仕組みの本体は `src/lib/repair/` にあります。

| ファイル | 役割 |
| --- | --- |
| `scan.ts` | 生データから映像フレーム（NAL）と音声フレーム（AAC）を検出 |
| `aac.ts` | AAC のビットストリーム構文を追ってフレーム境界を特定 |
| `h264.ts` / `hevc.ts` | SPS / PPS / スライスヘッダの解析と生成 |
| `estimate.ts` | 参考動画なしの場合の SPS / PPS 推定 |
| `indexRepair.ts` | 索引が残っているファイルの検証と修復 |
| `mp4.ts` | `moov` の読み取り・探索と、新しい `moov` の書き出し |

コマンドラインからも試せます（システムの `ffmpeg` が必要）。

```bash
npx tsx scripts/repair-cli.ts 壊れた動画.mp4 出力.mp4 [参考動画.mp4]
```

参考動画が必要な場合（索引も埋め込み設定もない HEVC）は、壊れた動画のデータからフレームレートと解像度を推定し、どの設定で参考動画を撮ればよいかを表示します。参考動画を指定したときは、その設定で先頭のフレームを試しにデコードし、設定が合っていない可能性があれば警告します。

### 既知の制限

- 索引がない HEVC は、映像の中に再生設定（VPS/SPS/PPS）が埋め込まれていれば参考動画なしで修復できます（多くのカメラ・ドライブレコーダー）。埋め込まれていない場合（iPhone など）は参考動画が必要です。
- フレームの途中から壊れている場合、その 1 フレームは検出できず、次のキーフレームまで映像が乱れることがあります。
- 索引がなくデータに穴がある場合、穴の長さはデータ量からの推定です。
- 索引がない場合、AAC 以外の音声（PCM など）は復元されず、映像のみになります。
- 参考動画なしの場合、x264 以外のエンコーダで `pic_init_qp` が 26 以外の動画は色や明るさが崩れることがあります（参考動画を指定すれば解決します）。
- 可変フレームレートの動画は一定のフレームレートとして書き出されます。
