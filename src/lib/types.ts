/** 報告の種類 */
export type ReportType = "improvement" | "damage" | "hiyari" | "trouble";

/** 緊急度 */
export type Urgency = "normal" | "soon" | "danger";

/** 報告のステータス。管理者アクションで遷移する */
export type ReportStatus = "new" | "reviewing" | "adopted" | "partial" | "declined";

/** 管理者が取れるアクション */
export type ActionType = "reviewing" | "adopted" | "partial" | "declined" | "thanks";

/** 共感の種類 */
export type ReactionKind = "like" | "same";

/**
 * 画像の参照。
 * - `/seed/xxx.svg` … リポジトリ同梱のサンプル画像
 * - `idb:<id>`      … 端末の IndexedDB に保存した投稿画像
 */
export type ImageRef = string;

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
  /** 「横展開したい」「全社共有」などのタグ */
  tags?: string[];
}

export interface Report {
  id: string;
  authorId: string;
  /** 匿名で投稿する */
  anonymous: boolean;
  type: ReportType;
  urgency: Urgency;
  title: string;
  body: string;
  /** 倉庫エリア */
  area: string;
  /** 場所の補足メモ */
  areaNote: string;
  beforeImage?: ImageRef;
  afterImage?: ImageRef;
  status: ReportStatus;
  createdAt: number;
  actions: AdminAction[];
  reactions: Record<ReactionKind, string[]>;
}

export interface User {
  id: string;
  name: string;
  role: "staff" | "admin";
  team: string;
  /** アバターの背景色 */
  color: string;
}

export interface DemoState {
  users: User[];
  reports: Report[];
  /** デモ用に切り替える現在のユーザー（現場スタッフ） */
  staffUserId: string;
  adminUserId: string;
  /** 現在のロール。ヘッダーで切り替える */
  role: "staff" | "admin";
}
