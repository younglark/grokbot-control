import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { DashboardTimeline, TimelineEntryView } from "@/types";

function fingerprint(entries: TimelineEntryView[]): string {
  const last = entries[entries.length - 1];
  return last ? `${entries.length}:${last.entry_id ?? ""}:${last.seq ?? ""}` : `0`;
}

function entryLabel(e: TimelineEntryView): string {
  if (e.decode_status === "omitted") return "正文已省略，未解密。";
  if (e.decode_status === "absent") return "没有可用正文。";
  if (e.decode_status === "opaque") return e.decode_reason ? `无法解析（${e.decode_reason}）` : "无法解析该条正文。";
  if (e.tool_name) return `${e.tool_name}${e.tool_status ? ` · ${e.tool_status}` : ""}${e.text ? ` — ${e.text}` : ""}`;
  if (e.attachment_name) return `附件：${e.attachment_name}`;
  return e.text || "（无文本）";
}

function roleLabel(role?: string): string {
  if (!role) return "条目";
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  return role;
}

export function ActivityTimeline({
  timeline,
  loading,
  onVisibleChange,
}: {
  timeline?: DashboardTimeline;
  loading?: boolean;
  onVisibleChange: (visible: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastFp = useRef<string>("");
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => onVisibleChange(Boolean(entry?.isIntersecting)),
      { threshold: 0.15 },
    );
    io.observe(el);
    onVisibleChange(true);
    return () => {
      io.disconnect();
      onVisibleChange(false);
    };
  }, [onVisibleChange]);

  useEffect(() => {
    const entries = timeline?.entries ?? [];
    const fp = fingerprint(entries);
    if (!lastFp.current) {
      lastFp.current = fp;
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
      return;
    }
    if (fp !== lastFp.current) {
      lastFp.current = fp;
      const el = scrollerRef.current;
      const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (followRef.current && atBottom) {
        requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
        setHasNew(false);
      } else {
        followRef.current = false;
        setHasNew(true);
      }
    }
  }, [timeline]);

  function onScroll() {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    followRef.current = atBottom;
    if (atBottom) setHasNew(false);
  }

  function jumpToLatest() {
    followRef.current = true;
    setHasNew(false);
    bottomRef.current?.scrollIntoView({ block: "end" });
  }

  return (
    <section ref={rootRef} data-testid="bot-timeline" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">活动时间线</h3>
        {timeline?.paused && <span className="text-xs text-muted-foreground">已离开视口，暂停更新</span>}
      </div>
      {timeline?.error && <p className="text-sm text-amber-700 dark:text-amber-400">{timeline.error}</p>}
      {!timeline && loading && <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>}
      {timeline && !timeline.session_id && <p className="text-sm text-muted-foreground">尚未选择可查看的会话，因此不加载成绩单。</p>}
      {timeline?.session_id && (
        <div className="relative">
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            data-testid="timeline-scroller"
            className="max-h-80 space-y-3 overflow-y-auto rounded-xl border p-3"
          >
            {timeline.entries.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">这条会话还没有可展示的活动。</p>}
            {timeline.entries.map((e, i) => (
              <article
                key={e.entry_id ?? e.seq ?? String(i)}
                data-testid="timeline-entry"
                className="rounded-lg bg-muted/40 px-3 py-2.5"
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{roleLabel(e.role)}</span>
                  {e.kind && <span>· {e.kind}</span>}
                  {e.timestamp_ms && (
                    <span>
                      · {new Date(Number(e.timestamp_ms)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                    </span>
                  )}
                </div>
                <p className={cn("whitespace-pre-wrap break-words text-sm leading-6", e.decode_status !== "decoded" && "text-muted-foreground")}>
                  {entryLabel(e)}
                </p>
              </article>
            ))}
            <div ref={bottomRef} data-testid="timeline-bottom" />
          </div>
          {hasNew && (
            <Button
              type="button"
              size="sm"
              data-testid="timeline-new-activity"
              className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-md"
              onClick={jumpToLatest}
            >
              <ArrowDown className="size-3.5" />
              有新活动
            </Button>
          )}
        </div>
      )}
      {timeline?.note && <p className="text-xs leading-5 text-muted-foreground">{timeline.note} 浏览较早内容时不会强制滚到底部。</p>}
    </section>
  );
}
