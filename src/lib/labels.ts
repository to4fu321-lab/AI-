import type {
  ActionType,
  DecisionActionType,
  ReportStatus,
  ReportType,
  ShareActionType,
  Urgency,
} from "./types";

/** 拠点。デモでは3拠点。札幌が舞台、船橋・大阪は横展開先として登場する */
export const SITES = ["札幌物流センター", "船橋物流センター", "大阪物流センター"] as const;

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
    value: "safety",
    label: "安全",
    short: "安全",
    emoji: "🦺",
    hint: "あぶなかった、ケガしそうだった",
  },
  {
    value: "efficiency",
    label: "作業効率",
    short: "効率",
    emoji: "⚡",
    hint: "もっとラクに・早くできそうなこと",
  },
  {
    value: "quality",
    label: "品質",
    short: "品質",
    emoji: "🎯",
    hint: "ミスや不具合につながりそうなこと",
  },
  {
    value: "equipment",
    label: "設備",
    short: "設備",
    emoji: "🔧",
    hint: "壊れている、足りない、動かない",
  },
  {
    value: "organization",
    label: "整理整頓",
    short: "整理整頓",
    emoji: "📦",
    hint: "置き場や表示をわかりやすくしたい",
  },
  {
    value: "inventory",
    label: "在庫",
    short: "在庫",
    emoji: "📋",
    hint: "在庫の過不足や、発注のズレ",
  },
  {
    value: "other",
    label: "その他",
    short: "その他",
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

/**
 * ステータス。未対応 → 確認中 → 採用（一部採用）/ 見送り という改善プロセスを表す。
 * 塗らずに小さな丸の色＋グレーの文字で見せる
 */
export const STATUSES: { value: ReportStatus; label: string; dot: string }[] = [
  { value: "new", label: "未対応", dot: "bg-dot-new" },
  { value: "reviewing", label: "確認中", dot: "bg-dot-reviewing" },
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
  { value: "working", label: "確認中", statuses: ["reviewing"] },
  { value: "done", label: "完了", statuses: ["adopted", "partial", "declined"] },
];

/** 「今回は見送る」を選ぶときの理由。判断の透明性を残す */
export const DECLINE_REASONS = [
  "コスト面で難しい",
  "安全面で懸念がある",
  "優先順位が他にある",
  "他部署との調整が必要",
  "設備上の制約がある",
  "現時点では対応不要",
  "その他",
] as const;

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
    label: "確認中にする",
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
    label: "他拠点へ横展開する",
    shortLabel: "横展開",
    pastLabel: "横展開しました",
    emoji: "🏢",
    points: 20,
    description: "良い改善を他拠点のフィードにも広げます",
  },
  {
    value: "share_hq",
    label: "本社へ報告する",
    shortLabel: "本社へ報告",
    pastLabel: "本社へ報告しました",
    emoji: "🏛",
    points: 10,
    description: "全社の改善事例として本社に共有します",
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
