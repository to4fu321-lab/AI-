import type { ActionType, ReportStatus, ReportType, Urgency } from "./types";

export const REPORT_TYPES: {
  value: ReportType;
  label: string;
  short: string;
  emoji: string;
  hint: string;
}[] = [
  {
    value: "improvement",
    label: "改善のアイデア",
    short: "改善",
    emoji: "💡",
    hint: "もっとラクに・早くできそうなこと",
  },
  {
    value: "damage",
    label: "破損・不具合",
    short: "破損",
    emoji: "🔧",
    hint: "壊れている、足りない、動かない",
  },
  {
    value: "hiyari",
    label: "ヒヤリハット",
    short: "ヒヤリ",
    emoji: "⚠️",
    hint: "あぶなかった、ケガしそうだった",
  },
  {
    value: "trouble",
    label: "困りごと",
    short: "困りごと",
    emoji: "🙋",
    hint: "毎回もやっとする、聞きたいこと",
  },
];

export const URGENCIES: { value: Urgency; label: string; className: string }[] = [
  { value: "normal", label: "通常", className: "bg-canvas text-ink-muted border-line" },
  { value: "soon", label: "早めに", className: "bg-amber-50 text-warn border-amber-200" },
  { value: "danger", label: "危険", className: "bg-red-50 text-danger border-red-200" },
];

export const STATUSES: {
  value: ReportStatus;
  label: string;
  className: string;
  dot: string;
}[] = [
  {
    value: "new",
    label: "未対応",
    className: "bg-brand-soft text-brand-dark border-brand-line",
    dot: "bg-brand",
  },
  {
    value: "reviewing",
    label: "検討中",
    className: "bg-amber-50 text-warn border-amber-200",
    dot: "bg-amber-500",
  },
  {
    value: "adopted",
    label: "採用",
    className: "bg-emerald-50 text-status-adopted border-emerald-200",
    dot: "bg-emerald-600",
  },
  {
    value: "partial",
    label: "一部採用",
    className: "bg-cyan-50 text-status-partial border-cyan-200",
    dot: "bg-cyan-600",
  },
  {
    value: "declined",
    label: "見送り",
    className: "bg-slate-100 text-status-declined border-slate-200",
    dot: "bg-slate-400",
  },
];

export const ACTIONS: {
  value: ActionType;
  label: string;
  emoji: string;
  points: number;
  /** タイムラインに表示する完了後の言い方 */
  pastLabel: string;
  description: string;
  requiresComment?: boolean;
}[] = [
  {
    value: "adopted",
    label: "採用する",
    pastLabel: "採用しました",
    emoji: "✅",
    points: 50,
    description: "実施が決まりました。投稿者に +50pt",
  },
  {
    value: "partial",
    label: "一部修正して採用",
    pastLabel: "一部修正して採用",
    emoji: "🛠",
    points: 30,
    description: "修正内容を添えて採用。投稿者に +30pt",
    requiresComment: true,
  },
  {
    value: "reviewing",
    label: "検討中にする",
    pastLabel: "確認しました",
    emoji: "👀",
    points: 0,
    description: "受け取ったことを伝える",
  },
  {
    value: "thanks",
    label: "お礼を送る",
    pastLabel: "お礼",
    emoji: "🙏",
    points: 5,
    description: "感謝を伝える。投稿者に +5pt",
  },
  {
    value: "declined",
    label: "今回は見送る",
    pastLabel: "今回は見送り",
    emoji: "📁",
    points: 0,
    description: "理由を必ず伝える",
    requiresComment: true,
  },
];

export const AREAS = [
  "A棟 ピッキングエリア",
  "A棟 入荷バース",
  "B棟 保管棚",
  "B棟 梱包ライン",
  "出荷バース",
  "資材置き場",
  "休憩室・共用部",
];

export const ACTION_TAGS = ["横展開したい", "全社共有", "安全パトロール項目"];

export function reportTypeOf(value: ReportType) {
  return REPORT_TYPES.find((t) => t.value === value) ?? REPORT_TYPES[0];
}

export function statusOf(value: ReportStatus) {
  return STATUSES.find((s) => s.value === value) ?? STATUSES[0];
}

export function urgencyOf(value: Urgency) {
  return URGENCIES.find((u) => u.value === value) ?? URGENCIES[0];
}

export function actionOf(value: ActionType) {
  return ACTIONS.find((a) => a.value === value) ?? ACTIONS[0];
}
