import type {
  ActionType,
  DecisionActionType,
  ReportStatus,
  ReportType,
  ShareActionType,
  Urgency,
} from "./types";

/** 拠点。デモでは3拠点 */
export const SITES = ["川崎物流センター", "船橋物流センター", "大阪物流センター"] as const;

/** 拠点内のエリア */
export const AREAS = [
  "ピッキングエリア",
  "入荷バース",
  "保管棚エリア",
  "梱包ライン",
  "出荷バース",
  "資材置き場",
  "休憩室・共用部",
];

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

/** 緊急度。バッジではなくカード左端の帯の色として使う */
export const URGENCIES: {
  value: Urgency;
  label: string;
  /** 一覧の並び順（小さいほど先） */
  weight: number;
  bar: string;
  text: string;
}[] = [
  { value: "danger", label: "危険", weight: 0, bar: "bg-danger", text: "text-danger" },
  { value: "soon", label: "早めに", weight: 1, bar: "bg-warn", text: "text-warn" },
  { value: "normal", label: "通常", weight: 2, bar: "bg-transparent", text: "text-ink-faint" },
];

/** ステータス。塗らずに小さな丸の色＋グレーの文字で見せる */
export const STATUSES: { value: ReportStatus; label: string; dot: string }[] = [
  { value: "new", label: "未対応", dot: "bg-dot-new" },
  { value: "reviewing", label: "対応中", dot: "bg-dot-reviewing" },
  { value: "adopted", label: "採用", dot: "bg-dot-adopted" },
  { value: "partial", label: "一部採用", dot: "bg-dot-partial" },
  { value: "declined", label: "見送り", dot: "bg-dot-declined" },
];

/** 管理ダッシュボードのフィルタ（3つに集約） */
export const ADMIN_FILTERS: {
  value: "new" | "working" | "done";
  label: string;
  statuses: ReportStatus[];
}[] = [
  { value: "new", label: "未対応", statuses: ["new"] },
  { value: "working", label: "対応中", statuses: ["reviewing"] },
  { value: "done", label: "完了", statuses: ["adopted", "partial", "declined"] },
];

export interface ActionMeta {
  value: ActionType;
  label: string;
  pastLabel: string;
  emoji: string;
  points: number;
  description: string;
  requiresComment?: boolean;
}

/** 対応アクション（どれか1つを選ぶ） */
export const ACTIONS: (ActionMeta & { value: DecisionActionType })[] = [
  {
    value: "adopted",
    label: "採用する",
    pastLabel: "採用しました",
    emoji: "✅",
    points: 50,
    description: "実施が決まりました",
  },
  {
    value: "partial",
    label: "一部修正して採用",
    pastLabel: "一部修正して採用",
    emoji: "🛠",
    points: 30,
    description: "修正内容を添えて採用します",
    requiresComment: true,
  },
  {
    value: "reviewing",
    label: "対応中にする",
    pastLabel: "確認しました",
    emoji: "👀",
    points: 0,
    description: "受け取ったことを伝えます",
  },
  {
    value: "thanks",
    label: "お礼を送る",
    pastLabel: "お礼",
    emoji: "🙏",
    points: 5,
    description: "感謝を伝えます",
  },
  {
    value: "declined",
    label: "今回は見送る",
    pastLabel: "今回は見送り",
    emoji: "📁",
    points: 0,
    description: "理由を必ず伝えます",
    requiresComment: true,
  },
];

/** 共有アクション（対応と両立する別軸。もう一度押すと解除） */
export const SHARE_OPTIONS: (ActionMeta & { value: ShareActionType; shortLabel: string })[] = [
  {
    value: "share_sites",
    label: "全拠点へ共有する",
    shortLabel: "全拠点へ共有",
    pastLabel: "全拠点へ共有しました",
    emoji: "🏢",
    points: 20,
    description: "他拠点のフィードにも事例として流れます",
  },
  {
    value: "share_hq",
    label: "本社へ報告する",
    shortLabel: "本社へ報告",
    pastLabel: "本社へ報告しました",
    emoji: "🏛",
    points: 10,
    description: "全社の改善事例として本社に上げます",
  },
];

const ALL_ACTIONS: ActionMeta[] = [...ACTIONS, ...SHARE_OPTIONS];

export function reportTypeOf(value: ReportType) {
  return REPORT_TYPES.find((t) => t.value === value) ?? REPORT_TYPES[0];
}

export function statusOf(value: ReportStatus) {
  return STATUSES.find((s) => s.value === value) ?? STATUSES[0];
}

export function urgencyOf(value: Urgency) {
  return URGENCIES.find((u) => u.value === value) ?? URGENCIES[2];
}

export function actionOf(value: ActionType): ActionMeta {
  return ALL_ACTIONS.find((a) => a.value === value) ?? ACTIONS[0];
}

export function shareOf(value: ShareActionType) {
  return SHARE_OPTIONS.find((s) => s.value === value) ?? SHARE_OPTIONS[0];
}
