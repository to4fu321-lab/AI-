/** 報告のカテゴリ。管理者が案件を整理・判断するための軸 */
export type ReportType =
  | "safety"
  | "efficiency"
  | "quality"
  | "equipment"
  | "organization"
  | "inventory"
  | "other";

/** 緊急度 */
export type Urgency = "normal" | "soon" | "danger";

/**
 * 報告のステータス。管理者の対応アクションで遷移する。
 * 未対応 → 確認中 → 採用（一部採用）→ 対応中 → 完了。見送りはどこからでも起こりうる
 */
export type ReportStatus =
  | "new"
  | "reviewing"
  | "adopted"
  | "partial"
  | "in_progress"
  | "done"
  | "declined";

/** 対応アクション（ステータスが変わる） */
export type DecisionActionType =
  | "reviewing"
  | "adopted"
  | "partial"
  | "in_progress"
  | "done"
  | "declined"
  | "thanks";

/** 共有アクション（ステータスとは別軸。採用と両立する） */
export type ShareActionType = "share_sites" | "share_hq";

export type ActionType = DecisionActionType | ShareActionType;

/** 共感の種類 */
export type ReactionKind = "like" | "same";

/**
 * 画像の参照。
 * - `/seed/xxx.svg` … リポジトリ同梱のサンプル画像
 * - `idb:<id>`      … 端末の IndexedDB に保存した投稿画像
 */
export type ImageRef = string;

/**
 * 改善の効果。完了時に管理者がざっくり選ぶだけで入る。
 *
 * 現場には入力させない。測定の負担の正体は「測ること」ではなく
 * 「正確に測ること」なので、精度を捨てて概算に振り、掛け算はアプリがやる
 */
export interface ImprovementEffect {
  /** 1回あたりの削減量 */
  amount: number;
  /** 秒か歩か。倉庫の動線改善は歩数で語るほうが伝わる */
  unit: "seconds" | "steps";
  /** 1日あたりの発生回数 */
  timesPerDay: number;
}

export interface AdminAction {
  id: string;
  type: ActionType;
  /** 管理者からのコメント（見送りの場合は必須） */
  comment: string;
  /** このアクションで投稿者に加算されるポイント */
  bonusPoints: number;
  actorId: string;
  createdAt: number;
  /** 採用時の実施予定 */
  plannedDate?: string;
  /** 完了時に記録する改善の効果（任意） */
  effect?: ImprovementEffect;
}

export interface Report {
  id: string;
  authorId: string;
  /** 匿名で投稿する */
  anonymous: boolean;
  /** 報告が上がった拠点 */
  site: string;
  type: ReportType;
  urgency: Urgency;
  title: string;
  body: string;
  /**
   * AIで文章を整えたときの、現場が書いた元のメモ。
   * 整えた文だけが残ると「誰の、どんな言葉だったか」が消えるので必ず持っておく
   */
  rawNote?: string;
  /** 拠点内のエリア */
  area: string;
  /** 場所の補足メモ */
  areaNote: string;
  beforeImage?: ImageRef;
  afterImage?: ImageRef;
  status: ReportStatus;
  /** 他拠点へ横展開された（他拠点のフィードにも流れる） */
  sharedToSites: boolean;
  /** 本社へ報告された */
  sharedToHq: boolean;
  createdAt: number;
  actions: AdminAction[];
  reactions: Record<ReactionKind, string[]>;
}

export interface User {
  id: string;
  name: string;
  role: "staff" | "admin";
  /** 所属拠点 */
  site: string;
  team: string;
  /** アバターの背景色 */
  color: string;
}

/** 管理者から現場への連絡の種類 */
export type NoticeCategory = "rule" | "share" | "monthly" | "info";

/**
 * 連絡を届ける相手。
 * 「全員」か「業務区分（班）」か「個人」の3通りだけに絞っている
 */
export type NoticeAudience =
  | { kind: "all" }
  | { kind: "teams"; teams: string[] }
  | { kind: "users"; userIds: string[] };

/** 管理者から現場へのお知らせ */
export interface Notice {
  id: string;
  /** 発信元の拠点。この拠点の人にだけ届く */
  site: string;
  category: NoticeCategory;
  title: string;
  body: string;
  audience: NoticeAudience;
  authorId: string;
  createdAt: number;
  /** 「確認しました」を押した人 */
  readBy: string[];
  /** 他拠点の改善を知らせる場合の、元になった報告 */
  reportId?: string;
}

export interface DemoState {
  users: User[];
  reports: Report[];
  notices: Notice[];
  /** デモ用に切り替える現在のユーザー（現場スタッフ） */
  staffUserId: string;
  adminUserId: string;
  /** 現在のロール。URL に合わせて切り替わる */
  role: "staff" | "admin";
}
