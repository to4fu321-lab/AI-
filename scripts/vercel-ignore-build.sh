#!/bin/bash
# Vercel の「ビルドするかどうか」の判定（vercel.json の ignoreCommand から呼ぶ）。
#   exit 0 … このビルドを取り消す / exit 1 … ビルドする
#
# 取り消すのは「試し版（preview）で、しかも本番用のブランチではない」とはっきりわかったときだけ。
# 本番の配置・本番用のブランチ・判定に使う値が読めないときは、必ずビルドする
# （判定を誤って本番の配置まで止めないように、迷ったらビルドする側に倒す）。

PRODUCTION_BRANCH="claude/session-AyaR1"

echo "ビルドの判定: VERCEL_ENV='${VERCEL_ENV}' VERCEL_TARGET_ENV='${VERCEL_TARGET_ENV}' ブランチ='${VERCEL_GIT_COMMIT_REF}'"

if [ "${VERCEL_ENV}" = "production" ] || [ "${VERCEL_TARGET_ENV}" = "production" ] || [ "${VERCEL_GIT_COMMIT_REF}" = "${PRODUCTION_BRANCH}" ]; then
  echo "→ 本番なのでビルドします"
  exit 1
fi

if [ "${VERCEL_ENV}" = "preview" ] && [ -n "${VERCEL_GIT_COMMIT_REF}" ]; then
  echo "→ 試し版（${VERCEL_GIT_COMMIT_REF}）なのでビルドしません"
  exit 0
fi

echo "→ 判定できないので、念のためビルドします"
exit 1
