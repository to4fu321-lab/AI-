"use client";

/**
 * デモ用の単一ストア。
 * 画面からのデータアクセスはすべてこのファイル経由にしてあるので、
 * ここの関数の中身を差し替えるだけで Supabase 等のバックエンドに移行できる。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createSeedState } from "@/data/seed";
import { clearImages, clearState, getImage, loadState, saveState } from "./storage";
import type {
  DecisionActionType,
  ShareActionType,
  AdminAction,
  DemoState,
  ReactionKind,
  Report,
  ReportStatus,
  ReportType,
  Urgency,
} from "./types";
import { actionOf } from "./labels";

let state: DemoState | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

/** SSR 時は常に null。各画面は読み込み中表示を出す */
function getServerSnapshot(): DemoState | null {
  return null;
}

function commit(next: DemoState) {
  state = next;
  saveState(next);
  emit();
}

function ensureLoaded() {
  if (state) return;
  const restored = loadState();
  state = restored ?? createSeedState(Date.now());
  if (!restored) saveState(state);
  emit();
}

/** 現在の状態。ハイドレーション完了までは null */
export function useDemoState(): DemoState | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureLoaded();
  }, []);
  return snapshot;
}

function requireState(): DemoState {
  if (!state) throw new Error("store is not ready");
  return state;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export interface NewReportInput {
  type: ReportType;
  urgency: Urgency;
  title: string;
  body: string;
  area: string;
  areaNote: string;
  beforeImage?: string;
  afterImage?: string;
  anonymous: boolean;
}

export function createReport(input: NewReportInput): Report {
  const current = requireState();
  const report: Report = {
    id: newId("r"),
    authorId: current.staffUserId,
    anonymous: input.anonymous,
    site: currentUserSite(current),
    type: input.type,
    urgency: input.urgency,
    title: input.title.trim(),
    body: input.body.trim(),
    area: input.area,
    areaNote: input.areaNote.trim(),
    beforeImage: input.beforeImage,
    afterImage: input.afterImage,
    status: "new",
    sharedToSites: false,
    sharedToHq: false,
    createdAt: Date.now(),
    actions: [],
    reactions: { like: [], same: [] },
  };
  commit({ ...current, reports: [report, ...current.reports] });
  return report;
}

/** 自分の投稿を修正する。ステータスや対応履歴はそのまま維持する */
export function updateReport(reportId: string, input: NewReportInput): Report | null {
  const current = requireState();
  let updated: Report | null = null;
  const reports = current.reports.map((report) => {
    if (report.id !== reportId) return report;
    updated = {
      ...report,
      type: input.type,
      urgency: input.urgency,
      title: input.title.trim(),
      body: input.body.trim(),
      area: input.area,
      areaNote: input.areaNote.trim(),
      anonymous: input.anonymous,
      beforeImage: input.beforeImage,
      afterImage: input.afterImage,
    };
    return updated;
  });
  commit({ ...current, reports });
  return updated;
}

/** 自分の投稿を取り消す */
export function deleteReport(reportId: string) {
  const current = requireState();
  commit({ ...current, reports: current.reports.filter((report) => report.id !== reportId) });
}

const STATUS_BY_ACTION: Record<DecisionActionType, ReportStatus | null> = {
  thanks: null,
  reviewing: "reviewing",
  adopted: "adopted",
  partial: "partial",
  in_progress: "in_progress",
  done: "done",
  declined: "declined",
};

function currentUserSite(current: DemoState): string {
  return (
    current.users.find((user) => user.id === current.staffUserId)?.site ?? "札幌物流センター"
  );
}

export function addAdminAction(
  reportId: string,
  type: DecisionActionType,
  comment: string,
  options: { plannedDate?: string } = {},
): AdminAction {
  const current = requireState();
  const action: AdminAction = {
    id: newId("a"),
    type,
    comment: comment.trim(),
    bonusPoints: actionOf(type).points,
    actorId: current.adminUserId,
    createdAt: Date.now(),
    plannedDate: options.plannedDate?.trim() || undefined,
  };
  const nextStatus = STATUS_BY_ACTION[type];
  commit({
    ...current,
    reports: current.reports.map((report) =>
      report.id === reportId
        ? {
            ...report,
            status: nextStatus ?? report.status,
            actions: [...report.actions, action],
          }
        : report,
    ),
  });
  return action;
}

/**
 * 共有のオン/オフ。対応ステータスとは別軸で、採用と両立する。
 * 解除したときはタイムラインの記録も消えるので、ポイントも自動的に元に戻る。
 */
export function toggleShare(reportId: string, type: ShareActionType) {
  const current = requireState();
  const key = type === "share_sites" ? "sharedToSites" : "sharedToHq";
  commit({
    ...current,
    reports: current.reports.map((report) => {
      if (report.id !== reportId) return report;
      const enabled = !report[key];
      const actions = enabled
        ? [
            ...report.actions,
            {
              id: newId("a"),
              type,
              comment: "",
              bonusPoints: actionOf(type).points,
              actorId: current.adminUserId,
              createdAt: Date.now(),
            },
          ]
        : report.actions.filter((action) => action.type !== type);
      return { ...report, [key]: enabled, actions };
    }),
  });
}

export function toggleReaction(reportId: string, kind: ReactionKind) {
  const current = requireState();
  const userId = current.staffUserId;
  commit({
    ...current,
    reports: current.reports.map((report) => {
      if (report.id !== reportId) return report;
      const list = report.reactions[kind];
      const next = list.includes(userId)
        ? list.filter((id) => id !== userId)
        : [...list, userId];
      return { ...report, reactions: { ...report.reactions, [kind]: next } };
    }),
  });
}

export function setRole(role: "staff" | "admin") {
  const current = requireState();
  commit({ ...current, role });
}

export function setStaffUser(userId: string) {
  const current = requireState();
  commit({ ...current, staffUserId: userId });
}

export async function resetDemo() {
  clearState();
  await clearImages();
  state = createSeedState(Date.now());
  saveState(state);
  emit();
}

/** 画像参照から表示可能な URL を作る。IndexedDB の Blob は objectURL 化する */
export function useImageUrl(ref?: string): string | null {
  const isBlobRef = Boolean(ref?.startsWith("idb:"));
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!ref || !ref.startsWith("idb:")) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    getImage(ref).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setBlobUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      setBlobUrl(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ref]);

  if (!ref) return null;
  return isBlobRef ? blobUrl : ref;
}

/** 現在のロールに応じた「自分」 */
export function useCurrentUser() {
  const demo = useDemoState();
  if (!demo) return null;
  const id = demo.role === "admin" ? demo.adminUserId : demo.staffUserId;
  return demo.users.find((user) => user.id === id) ?? null;
}

export function useUserMap() {
  const demo = useDemoState();
  return useCallback(
    (userId: string) => demo?.users.find((user) => user.id === userId) ?? null,
    [demo],
  );
}
