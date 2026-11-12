import type { DashboardBotDetail, DashboardEvidence, DashboardFrame, DashboardTimeline } from "@/types";

const CLIENT_KEY = "gbc-dashboard-client";
const EPOCH_KEY = "gbc-dashboard-epoch";

export function apiUrl(path: string): string {
  const base = document.baseURI || window.location.href;
  return new URL(path, base).toString();
}

// One consumer per document: sessionStorage is copied to popup windows by browsers.
// Never reuse that copied ID across independent SSE consumers.
const documentClientId = crypto.randomUUID();
export function dashboardClientId(): string { return documentClientId; }

export function dashboardEpoch(): string | undefined {
  try {
    return sessionStorage.getItem(EPOCH_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberEpoch(clientId: string, epoch: string): void {
  try {
    sessionStorage.setItem(CLIENT_KEY, clientId);
    sessionStorage.setItem(EPOCH_KEY, epoch);
  } catch {
    /* private mode */
  }
}

export type EventHandlers = {
  onFrame: (frame: DashboardFrame) => void;
  onDetail?: (detail: DashboardBotDetail) => void;
  onTimeline?: (timeline: DashboardTimeline) => void;
  onEvidence?: (evidence: DashboardEvidence) => void;
  onHello?: (hello: { client_id: string; connection_epoch: string }) => void;
  onStatus: (ok: boolean) => void;
};

export function connectEvents(handlers: EventHandlers): () => void {
  const es = new EventSource(apiUrl(`api/events?client=${encodeURIComponent(dashboardClientId())}`));
  const parse = <T,>(ev: MessageEvent, fn?: (data: T) => void) => {
    if (!fn) return;
    try {
      fn(JSON.parse(String(ev.data)) as T);
    } catch {
      /* ignore malformed */
    }
  };
  es.addEventListener("hello", (ev) =>
    parse(ev, (hello: { client_id: string; connection_epoch: string }) => {
      rememberEpoch(hello.client_id, hello.connection_epoch);
      handlers.onHello?.(hello);
    }),
  );
  es.addEventListener("snapshot", (ev) => parse(ev, handlers.onFrame));
  es.addEventListener("update", (ev) => parse(ev, handlers.onFrame));
  es.addEventListener("detail", (ev) => parse(ev, handlers.onDetail));
  es.addEventListener("timeline", (ev) => parse(ev, handlers.onTimeline));
  es.addEventListener("evidence", (ev) => parse(ev, handlers.onEvidence));
  es.onopen = () => handlers.onStatus(true);
  es.onerror = () => handlers.onStatus(false);
  return () => es.close();
}

export async function refreshUsage(): Promise<void> {
  await fetch(apiUrl("api/usage/refresh"), { method: "POST" });
}

export async function setFocus(input: {
  agent_id?: string;
  view_session_id?: string;
  timeline_visible?: boolean;
  graph_visible?: boolean;
  connection_epoch?: string;
}): Promise<{ detail?: DashboardBotDetail; timeline?: DashboardTimeline; evidence?: DashboardEvidence }> {
  const res = await fetch(apiUrl("api/focus"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: dashboardClientId(),
      connection_epoch: input.connection_epoch ?? dashboardEpoch(),
      agent_id: input.agent_id,
      view_session_id: input.view_session_id,
      timeline_visible: Boolean(input.timeline_visible),
      graph_visible: Boolean(input.graph_visible),
    }),
  });
  if (!res.ok) return {};
  try {
    return (await res.json()) as { detail?: DashboardBotDetail; timeline?: DashboardTimeline; evidence?: DashboardEvidence };
  } catch {
    return {};
  }
}
