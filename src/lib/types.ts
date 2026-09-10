/** 報告の種類 */
export type ReportType = "improvement" | "damage" | "hiyari" | "trouble";

/** 緊急度 */
export type Urgency = "normal" | "soon" | "danger";

/** 報告のステータス。管理者の対応アクションで遷移する */
export type ReportStatus = "new" | "reviewing" | "adopted" | "partial" | "declined";

/** 対応アクション（ステータスが変わる） */
export type DecisionActionType = "reviewing" | "adopted" | "partial" | "declined" | "thanks";

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
  /** 拠点内のエリア */
  area: string;
  /** 場所の補足メモ */
  areaNote: string;
  beforeImage?: ImageRef;
  afterImage?: ImageRef;
  status: ReportStatus;
  /** 全拠点へ共有された（他拠点のフィードにも流れる） */
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

export interface DemoState {
  users: User[];
  reports: Report[];
  /** デモ用に切り替える現在のユーザー（現場スタッフ） */
  staffUserId: string;
  adminUserId: string;
  /** 現在のロール。URL に合わせて切り替わる */
  role: "staff" | "admin";
}
