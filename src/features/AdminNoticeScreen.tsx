"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, LoadingBlock } from "@/components/EmptyState";
import { formatDateTime } from "@/lib/format";
import {
  NOTICE_CATEGORIES,
  actionOf,
  audienceText,
  noticeCategoryOf,
  noticeReaches,
} from "@/lib/labels";
import { monthlySummary, type MonthlySummary } from "@/lib/stats";
import {
  audienceSize,
  createNotice,
  deleteNotice,
  useDemoState,
} from "@/lib/store";
import { useNow } from "@/lib/useNow";
import type {
  AdminAction,
  DecisionActionType,
  Notice,
  NoticeAudience,
  NoticeCategory,
  Report,
  User,
} from "@/lib/types";

/** 決定・対応・完了など、コメントが残っているアクションだけを時系列で並べる */
const TIMELINE_ACTION_TYPES: DecisionActionType[] = [
  "reviewing",
  "adopted",
  "partial",
  "in_progress",
  "done",
];

function reportTimeline(report: Report): { label: string; comment: string }[] {
  return report.actions
    .filter(
      (action): action is AdminAction & { type: DecisionActionType } =>
        TIMELINE_ACTION_TYPES.includes(action.type as DecisionActionType) &&
        action.comment.trim().length > 0,
    )
    .map((action) => ({ label: actionOf(action.type).pastLabel, comment: action.comment }));
}

type AudienceKind = NoticeAudience["kind"];

const AUDIENCE_KINDS: { value: AudienceKind; label: string; hint: string }[] = [
  { value: "all", label: "全員", hint: "拠点のスタッフ全員に届きます" },
  { value: "teams", label: "業務区分", hint: "班を選んで届けます" },
  { value: "users", label: "個人", hint: "名前を選んで届けます" },
];

export function AdminNoticeScreen() {
  const demo = useDemoState();
  const now = useNow();

  const [category, setCategory] = useState<NoticeCategory | null>(null);
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("all");
  const [teams, setTeams] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [sourceReportId, setSourceReportId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sentTo, setSentTo] = useState<number | null>(null);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiResult, setAiResult] = useState<{ title: string; body: string } | null>(null);

  const mySite = demo?.users.find((user) => user.id === demo.adminUserId)?.site ?? null;

  const staff = useMemo(
    () => (demo && mySite ? demo.users.filter((u) => u.role === "staff" && u.site === mySite) : []),
    [demo, mySite],
  );

  const siteTeams = useMemo(() => [...new Set(staff.map((user) => user.team))], [staff]);

  const summary = useMemo(
    () => (demo && mySite ? monthlySummary(demo.reports.filter((r) => r.site === mySite), now) : null),
    [demo, mySite, now],
  );

  /** 他拠点から横展開されてきた事例。「他拠点の改善」の連絡はここから選ぶ */
  const sharedReports = useMemo(
    () =>
      (demo?.reports ?? [])
        .filter((report) => report.site !== mySite && report.sharedToSites)
        .sort((a, b) => b.createdAt - a.createdAt),
    [demo, mySite],
  );

  const sentNotices = useMemo(
    () =>
      (demo?.notices ?? [])
        .filter((notice) => notice.site === mySite)
        .sort((a, b) => b.createdAt - a.createdAt),
    [demo, mySite],
  );

  if (!demo || !mySite || !summary) return <LoadingBlock />;

  const audience: NoticeAudience =
    audienceKind === "all"
      ? { kind: "all" }
      : audienceKind === "teams"
        ? { kind: "teams", teams }
        : { kind: "users", userIds };

  const reach = audienceSize(demo, mySite, audience);
  const canSend = category !== null && title.trim().length > 0 && reach > 0;
  const selectedSourceReport = sharedReports.find((item) => item.id === sourceReportId) ?? null;

  const selectCategory = (value: NoticeCategory) => {
    setCategory(value);
    setSentTo(null);
    setAiResult(null);
    setAiError("");
    // 数字や事例をもとにした下書きを先に入れておく。
    // AIが使えない環境でもそのまま送れる状態にしておくための素の文章
    if (value === "monthly" && !title.trim() && !body.trim()) {
      const draft = monthlyTemplate(summary);
      setTitle(draft.title);
      setBody(draft.body);
    }
  };

  const selectSourceReport = (reportId: string) => {
    setSourceReportId(reportId);
    setAiResult(null);
    const report = sharedReports.find((item) => item.id === reportId);
    if (!report) return;
    const draft = shareTemplate(report);
    setTitle(draft.title);
    setBody(draft.body);
  };

  const runAi = async () => {
    setAiLoading(true);
    setAiError("");
    setAiResult(null);
    try {
      const report = sharedReports.find((item) => item.id === sourceReportId);
      const payload =
        category === "monthly"
          ? { kind: "monthly", site: mySite, summary }
          : {
              kind: "share",
              site: mySite,
              report: report
                ? {
                    site: report.site,
                    title: report.title,
                    body: report.body,
                    timeline: reportTimeline(report),
                  }
                : null,
            };
      const response = await fetch("/api/notice-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        setAiError(typeof data?.error === "string" ? data.error : "下書きできませんでした");
        return;
      }
      setAiResult({ title: data.title, body: data.body });
    } catch {
      setAiError("通信できませんでした");
    } finally {
      setAiLoading(false);
    }
  };

  const send = () => {
    if (!category || !canSend) return;
    createNotice({
      category,
      title,
      body,
      audience,
      reportId: category === "share" ? sourceReportId || undefined : undefined,
    });
    setSentTo(reach);
    setCategory(null);
    setAudienceKind("all");
    setTeams([]);
    setUserIds([]);
    setSourceReportId("");
    setTitle("");
    setBody("");
    setAiResult(null);
    setAiError("");
  };

  const canUseAi =
    category === "monthly" || (category === "share" && sourceReportId.length > 0);

  return (
    <div className="space-y-5">
      <Link
        href="/admin"
        className="inline-flex min-h-11 items-center text-body font-bold text-ink-muted"
      >
        ← ダッシュボード
      </Link>

      <header>
        <h1 className="text-title text-ink">お知らせを送る</h1>
        <p className="text-note text-ink-muted">
          {mySite}のスタッフに連絡を届けます。届く相手は選べます
        </p>
      </header>

      {sentTo !== null ? (
        <section className="card animate-pop border-brand p-4">
          <p className="text-head text-ink">✅ {sentTo}人に届けました</p>
          <p className="mt-1 text-note text-ink-muted">
            現場のお知らせ画面に表示されます。読んだ人数は「送ったお知らせ」で確認できます
          </p>
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr] lg:items-start">
          <div className="space-y-5">
            <Step number={1} title="どんな連絡ですか？">
              <div className="grid grid-cols-2 gap-2">
                {NOTICE_CATEGORIES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => selectCategory(item.value)}
                    aria-pressed={category === item.value}
                    className={`card flex min-h-16 items-center gap-2 p-3 text-left transition ${
                      category === item.value ? "border-brand bg-brand-soft" : ""
                    }`}
                  >
                    <span aria-hidden className="text-lg">
                      {item.emoji}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-head text-ink">{item.label}</span>
                      <span className="block truncate text-note text-ink-faint">{item.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Step>

            <Step number={2} title="誰に届けますか？">
              <div className="flex gap-2">
                {AUDIENCE_KINDS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setAudienceKind(item.value)}
                    aria-pressed={audienceKind === item.value}
                    className={`min-h-11 flex-1 rounded-full border text-note font-bold transition ${
                      audienceKind === item.value
                        ? "border-brand bg-brand text-white"
                        : "border-line bg-surface text-ink-muted"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {audienceKind === "teams" ? (
                <ChipGroup
                  items={siteTeams.map((team) => ({
                    key: team,
                    label: `${team}（${staff.filter((u) => u.team === team).length}人）`,
                  }))}
                  selected={teams}
                  onToggle={(key) =>
                    setTeams((current) =>
                      current.includes(key)
                        ? current.filter((item) => item !== key)
                        : [...current, key],
                    )
                  }
                />
              ) : null}

              {audienceKind === "users" ? (
                <ChipGroup
                  items={staff.map((user) => ({
                    key: user.id,
                    label: `${user.name}（${user.team}）`,
                  }))}
                  selected={userIds}
                  onToggle={(key) =>
                    setUserIds((current) =>
                      current.includes(key)
                        ? current.filter((item) => item !== key)
                        : [...current, key],
                    )
                  }
                />
              ) : null}

              <p className={`text-note font-bold ${reach > 0 ? "text-ink" : "text-danger"}`}>
                {reach > 0
                  ? `${audienceText(audience, demo.users)} ${reach}人に届きます`
                  : "届く人がいません。宛先を選んでください"}
              </p>
            </Step>

            <Step number={3} title="内容を書く">
              {category === "share" ? (
                <label className="block">
                  <span className="mb-1 block text-note text-ink-muted">
                    どの拠点の改善事例を紹介しますか？
                  </span>
                  <select
                    value={sourceReportId}
                    onChange={(event) => selectSourceReport(event.target.value)}
                    className="min-h-12 w-full rounded-lg border border-line bg-canvas px-3 text-body text-ink outline-none focus:border-brand"
                  >
                    <option value="">選んでください</option>
                    {sharedReports.map((report) => (
                      <option key={report.id} value={report.id}>
                        {report.site}：{report.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {category === "share" && selectedSourceReport ? (
                <SharePreview report={selectedSourceReport} />
              ) : null}

              {category === "monthly" ? <SummaryPreview summary={summary} /> : null}

              {canUseAi ? (
                <div>
                  <button
                    type="button"
                    onClick={runAi}
                    disabled={aiLoading}
                    className="flex min-h-11 w-full items-center justify-center rounded-full border border-brand bg-brand-soft text-note font-bold text-brand-dark transition active:scale-[0.99] disabled:border-line disabled:bg-canvas disabled:text-ink-faint"
                  >
                    {aiLoading ? "下書きしています…" : "✨ AIに読みやすく整えてもらう"}
                  </button>
                  <p className="mt-1 text-note text-ink-faint">
                    {category === "monthly"
                      ? "数字はアプリが集計したものをそのまま使います。AIは文章にするだけです"
                      : "選んだ報告の内容だけを使います。書かれていないことは足しません"}
                  </p>
                  {aiError ? <p className="mt-1 text-note text-danger">{aiError}</p> : null}

                  {aiResult ? (
                    <div className="mt-2 space-y-2 rounded-lg border border-line bg-canvas p-3">
                      <p className="text-note font-bold text-ink-muted">AIの下書き</p>
                      <p className="text-body font-bold text-ink">{aiResult.title}</p>
                      <p className="whitespace-pre-wrap text-body text-ink-muted">
                        {aiResult.body}
                      </p>
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => {
                            setTitle(aiResult.title);
                            setBody(aiResult.body);
                            setAiResult(null);
                          }}
                          className="min-h-11 flex-1 rounded-full bg-brand text-note font-bold text-white transition active:scale-[0.99]"
                        >
                          これにする
                        </button>
                        <button
                          type="button"
                          onClick={() => setAiResult(null)}
                          className="min-h-11 rounded-full border border-line px-4 text-note font-bold text-ink-muted"
                        >
                          元のまま
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <label className="block">
                <span className="mb-1 block text-note text-ink-muted">タイトル</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={40}
                  placeholder="例）延長コードは通路をまたがないでください"
                  className="min-h-12 w-full rounded-lg border border-line bg-canvas px-3 text-body text-ink outline-none focus:border-brand"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-note text-ink-muted">本文</span>
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={7}
                  placeholder="変わること、いつからか、お願いしたいことを書いてください"
                  className="w-full rounded-lg border border-line bg-canvas p-3 text-body text-ink outline-none focus:border-brand"
                />
              </label>

              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className="min-h-14 w-full rounded-full bg-brand text-head text-white transition active:scale-[0.99] disabled:bg-line disabled:text-ink-faint"
              >
                {category === null
                  ? "連絡の種類を選んでください"
                  : reach > 0
                    ? `${reach}人に送る`
                    : "宛先を選んでください"}
              </button>
            </Step>
        </div>

        <SentList notices={sentNotices} staff={staff} />
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <h2 className="flex items-center gap-2 text-head text-ink">
        <span
          aria-hidden
          className="grid h-6 w-6 place-items-center rounded-full bg-brand text-note font-bold text-white"
        >
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ChipGroup({
  items,
  selected,
  onToggle,
}: {
  items: { key: string; label: string }[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => {
        const on = selected.includes(item.key);
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onToggle(item.key)}
            aria-pressed={on}
            className={`min-h-11 rounded-full border px-3 text-note font-bold transition ${
              on ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-surface text-ink-muted"
            }`}
          >
            {on ? "✓ " : ""}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** AIに渡す数字をそのまま見せる。どこから出た数字かが分かるようにするため */
function SummaryPreview({ summary }: { summary: MonthlySummary }) {
  const rows = [
    { label: "今月の報告", value: `${summary.reportCount}件` },
    { label: "報告した人", value: `${summary.reporterCount}人` },
    { label: "採用が決定", value: `${summary.adoptedCount}件` },
    { label: "改善が完了", value: `${summary.doneCount}件` },
    { label: "危険の報告", value: `${summary.dangerCount}件` },
    { label: "他拠点へ横展開", value: `${summary.sharedCount}件` },
  ];

  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <p className="mb-2 text-note font-bold text-ink">
        {summary.month}月の集計（アプリが数えた数字です）
      </p>
      <dl className="grid grid-cols-3 gap-y-2">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-note text-ink-faint">{row.label}</dt>
            <dd className="text-body font-bold text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** AIに渡す材料をそのまま見せる。現場の声と管理者コメントの出どころが分かるようにするため */
function SharePreview({ report }: { report: Report }) {
  const timeline = reportTimeline(report);

  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <p className="mb-2 text-note font-bold text-ink">
        {report.site}の報告（材料としてそのまま使います）
      </p>
      <p className="text-note text-ink-faint">現場からの報告</p>
      <p className="mb-2 whitespace-pre-wrap text-body text-ink">{report.body}</p>
      {timeline.length > 0 ? (
        <>
          <p className="text-note text-ink-faint">対応の経過（管理者コメント）</p>
          <ul className="space-y-1">
            {timeline.map((item, index) => (
              <li key={index} className="text-body text-ink">
                <span className="font-bold text-ink-muted">{item.label}：</span>
                {item.comment}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-note text-ink-faint">まだ対応の経過コメントはありません</p>
      )}
    </div>
  );
}

function SentList({ notices, staff }: { notices: Notice[]; staff: User[] }) {
  return (
    <section className="space-y-2.5">
      <h2 className="text-head text-ink">送ったお知らせ</h2>
      {notices.length === 0 ? (
        <EmptyState emoji="📭" title="まだ送っていません" />
      ) : (
        <ul className="space-y-2">
          {notices.map((notice) => {
            const category = noticeCategoryOf(notice.category);
            const target = staff.filter((user) => noticeReaches(notice.audience, user)).length;
            return (
              <li key={notice.id} className="card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-note text-ink-muted">
                    <span aria-hidden>{category.emoji}</span> {category.label}
                  </span>
                  <span className="ml-auto text-note text-ink-faint">
                    {formatDateTime(notice.createdAt)}
                  </span>
                </div>
                <p className="mt-0.5 text-head text-ink">{notice.title}</p>
                <p className="mt-0.5 text-note text-ink-muted">
                  {audienceText(notice.audience, staff)}・確認 {notice.readBy.length}/{target}人
                </p>
                <button
                  type="button"
                  onClick={() => deleteNotice(notice.id)}
                  className="mt-1 min-h-11 text-note font-bold text-ink-faint"
                >
                  取り消す
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** AIが使えないときでもそのまま送れる、数字だけを並べた下書き */
function monthlyTemplate(summary: MonthlySummary): { title: string; body: string } {
  const lines = [
    `今月は${summary.reportCount}件の報告が届きました。`,
    summary.adoptedCount > 0 ? `そのうち${summary.adoptedCount}件の採用が決まりました。` : "",
    summary.doneCount > 0 ? `${summary.doneCount}件は改善として完了しています。` : "",
    summary.dangerCount > 0 ? `危険に関する報告は${summary.dangerCount}件でした。` : "",
    summary.sharedCount > 0 ? `${summary.sharedCount}件を他拠点へ横展開しました。` : "",
    "報告してくれたみなさん、ありがとうございます。",
  ].filter(Boolean);

  return {
    title: `${summary.month}月の改善まとめ：報告${summary.reportCount}件、完了${summary.doneCount}件`.slice(
      0,
      40,
    ),
    body: lines.join("\n"),
  };
}

function shareTemplate(report: Report): { title: string; body: string } {
  const timeline = reportTimeline(report);
  const outcome = timeline.find((item) => item.label.includes("完了"))?.comment ?? "";

  return {
    title: `他拠点の改善事例：${report.title}`.slice(0, 40),
    body: [
      `${report.site}であった改善事例を紹介します。`,
      `現場からの報告：${report.body}`,
      outcome ? `対応後、現場は次のように変わりました：${outcome}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
