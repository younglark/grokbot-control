import type { DashboardFrame } from "../types";

export function apiUrl(path: string): string {
  const base = document.baseURI || window.location.href;
  return new URL(path, base).toString();
}

export function connectEvents(onFrame: (frame: DashboardFrame) => void, onStatus: (ok: boolean) => void): () => void {
  const es = new EventSource(apiUrl("api/events"));
  const handle = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(String(ev.data)) as DashboardFrame;
      onFrame(data);
    } catch {
      /* ignore malformed */
    }
  };
  es.addEventListener("snapshot", handle);
  es.addEventListener("update", handle);
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  return () => es.close();
}

export async function refreshUsage(): Promise<void> {
  await fetch(apiUrl("api/usage/refresh"), { method: "POST" });
}
