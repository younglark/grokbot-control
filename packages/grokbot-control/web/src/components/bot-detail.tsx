import { StatusIcon, STATUS_META } from "@/components/status-icon";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, CATEGORY_LABEL, formatBreakdownShare } from "@/lib/utils";
import { useState } from "react";
import type { AgentTaskView, DashboardBotDetail, DashboardBotRow, DashboardTimeline, TodoItemView, UsageBreakdownKind, UsageBreakdownRow } from "@/types";

const TODO_LABEL: Record<TodoItemView["status"], string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  unspecified: "未指定",
  unknown: "未知",
};

const KIND_LABEL: Record<UsageBreakdownKind, string> = {
  billed_cents: "按金额拆分（币种未核实）",
  weekly_limit_ppm: "占周限额百分比",
  billing_cycle_ppm: "占账期限额百分比",
  empty: "没有明细",
};

function Status({ row }: { row: DashboardBotRow }) {
  const meta = STATUS_META[row.category];
  return (
    <Badge data-status-surface="list" variant="secondary" title={meta.help} className={cn("gap-1.5 font-normal shrink-0", meta.badge)}>
      <StatusIcon category={row.category} />
      {meta.label}
    </Badge>
  );
}

function TaskList({ todos, error }: { todos?: TodoItemView[]; error?: string }) {
  if (error) return <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>;
  if (!todos) return <Skeleton className="h-16 w-full" />;
  if (!todos.length) return <p className="text-sm text-muted-foreground">暂无待办。</p>;
  return (
    <ul className="space-y-2" data-testid="bot-todo-list">
      {todos.map((t) => (
        <li key={t.id} className="rounded-lg border px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm leading-6">{t.content || t.id}</p>
            <Badge variant="outline" className="font-normal">{TODO_LABEL[t.status]}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

function NativeTasks({ tasks, error }: { tasks?: AgentTaskView[]; error?: string }) {
  if (error) return <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>;
  if (!tasks) return <Skeleton className="h-16 w-full" />;
  if (!tasks.length) return <p className="text-sm text-muted-foreground">暂无任务。</p>;
  return (
    <ul className="space-y-2" data-testid="bot-task-list">
      {tasks.map((t) => (
        <li key={t.id} className="rounded-lg border px-3 py-2">
          <p className="text-sm font-medium">{t.name || t.id}</p>
          {t.description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.description}</p>}
          {t.status && <p className="mt-1 text-xs text-muted-foreground">{t.status}</p>}
        </li>
      ))}
    </ul>
  );
}

function BreakdownRows({ rows, kind }: { rows: UsageBreakdownRow[]; kind?: UsageBreakdownKind }) {
  return (
    <ul className="space-y-1.5 text-sm" data-testid="bot-usage-breakdown">
      {rows.map((r, i) => (
        <li key={`${r.bot_id ?? r.source ?? i}-${r.day_ms ?? i}`} className="flex justify-between gap-3">
          <span className="text-muted-foreground">{r.source ?? r.bot_id ?? "条目"}</span>
          <span className="tabular-nums">
            {formatBreakdownShare(r, kind)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BotDetail({
  row,
  detail,
  timeline,
  viewSession,
  mobile,
  onViewSession,
  onTimelineVisible,
}: {
  row: DashboardBotRow;
  detail?: DashboardBotDetail;
  timeline?: DashboardTimeline;
  viewSession?: string;
  mobile?: boolean;
  onViewSession: (sessionId: string) => void;
  onTimelineVisible: (visible: boolean) => void;
}) {
  const view = detail
    ? {
        ...detail.session_view,
        viewed_session_id: viewSession ?? detail.session_view.viewed_session_id ?? detail.session_view.current_session_id,
      }
    : undefined;
  return (
    <Card className="gap-5 shadow-none" data-testid="bot-detail">
      <CardHeader>
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border bg-muted text-xl font-medium">
          {(row.bot.title || row.bot.name || "B").slice(0, 1)}
        </div>
        <CardTitle className="break-words text-xl leading-7">{row.bot.title || row.bot.name}</CardTitle>
        <CardDescription className="break-words">{row.bot.description || "Bot 身份、任务与活动"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Status row={row} />
        <dl className="space-y-5 text-sm">
          <div>
            <dt className="mb-2 text-xs text-muted-foreground">AGENT ID</dt>
            <dd className="break-all font-mono text-xs leading-5">{row.bot.agent_id}</dd>
          </div>
          <div>
            <dt className="mb-2 text-xs text-muted-foreground">当前状态</dt>
            <dd>{CATEGORY_LABEL[row.category]}</dd>
          </div>
          {row.waiting_reason && (
            <div>
              <dt className="mb-2 text-xs text-muted-foreground">等待原因</dt>
              <dd className="break-words leading-6">{row.waiting_reason}</dd>
            </div>
          )}
        </dl>

        <Separator />
        <section data-testid="bot-sessions" className="space-y-3">
          <h3 className="text-sm font-medium">会话</h3>
          {detail?.sessions_error && <p className="text-sm text-amber-700 dark:text-amber-400">{detail.sessions_error}</p>}
          {!detail && <Skeleton className="h-16 w-full" />}
          {detail && detail.sessions.length === 0 && !detail.sessions_error && (
            <p className="text-sm text-muted-foreground">没有可展示的会话。</p>
          )}
          {view?.current_session_id && (
            <p className="text-xs text-muted-foreground">
              当前会话：<span className="font-mono">{view.current_session_id}</span>
              {view.current_session_source === "status" ? "（来自状态）" : view.current_session_source === "viewer_session" ? "（来自 viewer_session）" : ""}
            </p>
          )}
          {view && view.current_session_source === "none" && (
            <p className="text-xs text-muted-foreground">无法从状态或 viewer_session 确认当前会话，仅展示只读列表。</p>
          )}
          {view?.switch_error && <p data-testid="session-switch-error" className="text-sm text-amber-700 dark:text-amber-400">{view.switch_error}</p>}
          {detail && detail.sessions.length > 0 && (
            <ul className="space-y-2">
              {detail.sessions.map((s) => {
                const current = s.session_id === view?.current_session_id;
                const viewed = s.session_id === view?.viewed_session_id;
                return (
                  <li key={s.session_id}>
                    <Button
                      type="button"
                      variant={viewed ? "secondary" : "outline"}
                      className="h-auto w-full justify-between gap-2 whitespace-normal px-3 py-2 text-left"
                      data-testid="session-option"
                      onClick={() => onViewSession(s.session_id)}
                      disabled={!view?.switch_available}
                    >
                      <span className="min-w-0">
                        <span className="block font-mono text-xs break-all">{s.session_id}</span>
                        {s.kind && <span className="text-[11px] text-muted-foreground">{s.kind}</span>}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        {current && <Badge variant="outline" className="font-normal">当前</Badge>}
                        {viewed && <Badge className="font-normal">正在查看</Badge>}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {view?.note && <p className="text-xs leading-5 text-muted-foreground">{view.note}</p>}
        </section>

        <Separator />
        <section data-testid="bot-todos" className="space-y-3">
          <h3 className="text-sm font-medium">任务</h3>
          <p className="text-xs text-muted-foreground">仅在成功读到稳定 DTO 后展示，不会编造待办。任务与活动分开，不合并成一个百分比。</p>
          <div className="space-y-2">
            <h4 className="text-xs text-muted-foreground">待办</h4>
            <TaskList todos={detail?.todos} error={detail?.todos_error} />
          </div>
          <div className="space-y-2" data-testid="bot-tasks">
            <h4 className="text-xs text-muted-foreground">任务项</h4>
            <NativeTasks tasks={detail?.tasks} error={detail?.tasks_error} />
          </div>
          <div className="space-y-2" data-testid="bot-subagents">
            <h4 className="text-xs text-muted-foreground">子代理</h4>
            {detail?.subagents_error && <p className="text-sm text-amber-700 dark:text-amber-400">{detail.subagents_error}</p>}
            {!detail && <Skeleton className="h-10 w-full" />}
            {detail && !detail.subagents_error && (detail.subagents?.length ? (
              <ul className="space-y-2">
                {detail.subagents.map((s) => (
                  <li key={s.subagent_id} className="rounded-lg border px-3 py-2 text-sm">
                    {s.title || s.subagent_id}
                    {s.subagent_type && <span className="ml-2 text-xs text-muted-foreground">{s.subagent_type}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">暂无子代理。</p>
            ))}
          </div>
        </section>

        {detail?.usage_breakdown && detail.usage_breakdown.length > 0 && (
          <>
            <Separator />
            <section className="space-y-3">
              <h3 className="text-sm font-medium">此 Bot 的用量明细</h3>
              <p className="text-xs text-muted-foreground">{KIND_LABEL[detail.usage_breakdown_kind ?? "empty"]}</p>
              <BreakdownRows rows={detail.usage_breakdown} kind={detail.usage_breakdown_kind} />
            </section>
          </>
        )}
        {detail?.usage_breakdown_error && !detail.usage_breakdown && (
          <p className="text-xs text-muted-foreground">用量明细读取失败：{detail.usage_breakdown_error}</p>
        )}

        <Separator />
        <ActivityTimeline timeline={timeline} loading={!timeline && Boolean(view?.viewed_session_id)} onVisibleChange={onTimelineVisible} />
      </CardContent>
    </Card>
  );
}
