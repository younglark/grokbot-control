import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { ControlPlane } from "../ops/plane.js";
import type { DashboardFocus } from "../dto/types.js";
import { GbcError } from "../errors.js";
import {
  DEFAULT_HOST,
  hostOriginAllowed,
  listenOn,
  parseHost,
  parsePort,
  publicUrl,
  type BindTarget,
} from "./bind.js";
import { DashboardPoller, type DashboardPollerOptions } from "./poller.js";
import { payloadLooksSecret } from "./sanitize.js";

export type DashboardServerOptions = {
  plane: ControlPlane;
  host?: string;
  port?: number;
  /** Override static UI root (tests). */
  uiRoot?: string;
  /** Override session token (tests). */
  sessionToken?: string;
  /** Test-only poll interval overrides. */
  poller?: DashboardPollerOptions;
};

export type StartedDashboard = {
  url: string;
  bind: BindTarget;
  sessionPath: string;
  server: http.Server;
  poller: DashboardPoller;
  close: () => Promise<void>;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Local `gbc dashboard` HTTP+SSE server. Independent of official DashboardService
 * write RPCs: this process only serves the packed UI and read-only frames.
 */
export async function startDashboardServer(opts: DashboardServerOptions): Promise<StartedDashboard> {
  const host = parseHost(opts.host);
  const port = opts.port ?? 8787;
  const resolvedUi = opts.uiRoot ?? resolveDashboardUiRoot();
  if (!resolvedUi) {
    throw new GbcError(
      "error",
      "dashboard UI is not built (missing dist/dashboard/index.html); run npm run build",
      { exitCode: 1, hint: "npm run build   # or: npm run build -w grokbot-control" },
    );
  }
  const uiRoot = resolvedUi;
  const sessionToken = opts.sessionToken ?? randomBytes(18).toString("base64url");
  const sessionPath = `/s/${sessionToken}/`;
  const poller = new DashboardPoller(opts.plane, opts.poller);
  await poller.start();

  const sseClients = new Set<http.ServerResponse>();
  const unsubscribe = poller.subscribe((frame) => broadcast(sseClients, "update", frame));
  const unsubscribeDetail = poller.subscribeDetail((detail) => broadcast(sseClients, "detail", detail));
  const unsubscribeTimeline = poller.subscribeTimeline((timeline) => broadcast(sseClients, "timeline", timeline));
  const unsubscribeEvidence = poller.subscribeEvidence((evidence) => broadcast(sseClients, "evidence", evidence));

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  let bind: BindTarget;
  try {
    bind = await listenOn(server, host, port);
  } catch (e) {
    unsubscribe();
    unsubscribeDetail();
    unsubscribeTimeline();
    unsubscribeEvidence();
    poller.close();
    throw e;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const hostHeader = req.headers.host;
    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!hostOriginAllowed(bind, hostHeader, origin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden host or origin");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${hostHeader ?? `${bind.host}:${bind.port}`}`);
    const pathname = url.pathname;

    if (pathname === sessionPath.slice(0, -1)) {
      res.writeHead(302, { location: sessionPath });
      res.end();
      return;
    }
    if (!pathname.startsWith(sessionPath)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const rest = pathname.slice(sessionPath.length);
    if (req.method === "GET" && (rest === "api/events" || rest === "api/events/")) {
      attachSse(req, res);
      return;
    }
    if (req.method === "POST" && (rest === "api/usage/refresh" || rest === "api/usage/refresh/")) {
      await poller.refreshUsage();
      return writeJson(res, { ok: true }, poller.current);
    }
    if (req.method === "POST" && (rest === "api/focus" || rest === "api/focus/")) {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "invalid focus" }));
        return;
      }
      const focus = parseFocus(body, url.searchParams.get("client"));
      if (!focus) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "invalid focus" }));
        return;
      }
      poller.setFocus(focus);
      const detail = focus.agent_id ? poller.getDetail(focus.agent_id, focus.client_id) : undefined;
      const timeline = focus.agent_id
        ? poller.getTimeline(focus.agent_id, focus.view_session_id ?? detail?.session_view.viewed_session_id)
        : undefined;
      const evidence = focus.agent_id
        ? poller.getEvidence(focus.agent_id, focus.view_session_id ?? detail?.session_view.viewed_session_id)
        : undefined;
      return writeJson(res, { ok: true, detail, timeline, evidence }, { detail, timeline, evidence });
    }
    const detailMatch = /^api\/bots\/([^/]+)\/detail\/?$/.exec(rest);
    if (req.method === "GET" && detailMatch) {
      const agentId = decodeURIComponent(detailMatch[1]!);
      const detail = poller.getDetail(agentId);
      if (!detail) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "detail not focused or not yet loaded" }));
        return;
      }
      return writeJson(res, detail, detail);
    }
    const timelineMatch = /^api\/bots\/([^/]+)\/timeline\/?$/.exec(rest);
    if (req.method === "GET" && timelineMatch) {
      const agentId = decodeURIComponent(timelineMatch[1]!);
      const sessionId = url.searchParams.get("session_id") ?? undefined;
      const timeline = poller.getTimeline(agentId, sessionId);
      if (!timeline) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "timeline not focused or not yet loaded" }));
        return;
      }
      return writeJson(res, timeline, timeline);
    }
    const evidenceMatch = /^api\/bots\/([^/]+)\/evidence\/?$/.exec(rest);
    if (req.method === "GET" && evidenceMatch) {
      const agentId = decodeURIComponent(evidenceMatch[1]!);
      const sessionId = url.searchParams.get("session_id") ?? undefined;
      const evidence = poller.getEvidence(agentId, sessionId);
      return writeJson(res, evidence, evidence);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, POST" });
      res.end();
      return;
    }
    await serveStatic(uiRoot, rest, req, res);
  }

  function attachSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientId = urlClientId(req) ?? randomBytes(12).toString("base64url");
    const connectionEpoch = randomBytes(8).toString("hex");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sseClients.add(res);
    poller.browserConnected(clientId, connectionEpoch);
    writeSse(res, "hello", { client_id: clientId, connection_epoch: connectionEpoch });
    writeSse(res, "snapshot", poller.current);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 15_000);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      sseClients.delete(res);
      poller.browserDisconnected(clientId, connectionEpoch);
    };
    req.on("close", done);
    res.on("close", done);
  }

  const close = () =>
    new Promise<void>((resolve) => {
      unsubscribe();
      unsubscribeDetail();
      unsubscribeTimeline();
      unsubscribeEvidence();
      poller.close();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      server.close(() => resolve());
      // In case close hangs on keep-alive
      setTimeout(() => resolve(), 1000).unref();
    });

  return {
    url: publicUrl(bind, sessionPath),
    bind,
    sessionPath,
    server,
    poller,
    close,
  };
}

function broadcast(clients: Set<http.ServerResponse>, event: string, payload: unknown): void {
  if (payloadLooksSecret(payload)) return;
  for (const res of clients) writeSse(res, event, payload);
}

function writeSse(res: http.ServerResponse, event: string, payload: unknown): void {
  if (payloadLooksSecret(payload)) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* closed */
  }
}

function writeJson(res: http.ServerResponse, body: unknown, check: unknown = body): void {
  if (payloadLooksSecret(check) || payloadLooksSecret(body)) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("refusing to emit a frame that looks like it contains a secret");
    return;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function urlClientId(req: http.IncomingMessage): string | undefined {
  try {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    return u.searchParams.get("client") ?? undefined;
  } catch {
    return undefined;
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new GbcError("error", "focus payload too large", { exitCode: 1 });
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseFocus(body: unknown, fallbackClient?: string | null): DashboardFocus | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;
  const client = String(raw.client_id ?? raw.clientId ?? fallbackClient ?? "").trim();
  if (!client) return undefined;
  const agent = raw.agent_id ?? raw.agentId;
  const session = raw.view_session_id ?? raw.viewSessionId;
  const epoch = raw.connection_epoch ?? raw.connectionEpoch;
  return {
    client_id: client,
    ...(typeof epoch === "string" && epoch.trim() ? { connection_epoch: epoch.trim() } : {}),
    ...(typeof agent === "string" && agent.trim() ? { agent_id: agent.trim() } : {}),
    ...(typeof session === "string" && session.trim() ? { view_session_id: session.trim() } : {}),
    timeline_visible: Boolean(raw.timeline_visible ?? raw.timelineVisible),
    graph_visible: Boolean(raw.graph_visible ?? raw.graphVisible),
  };
}

async function serveStatic(
  uiRoot: string,
  rest: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const rel = rest === "" || rest === "/" ? "index.html" : rest.replace(/^\/+/, "");
  const resolved = path.resolve(uiRoot, rel);
  const root = path.resolve(uiRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  let file = resolved;
  try {
    const st = await fs.promises.stat(file);
    if (st.isDirectory()) file = path.join(file, "index.html");
  } catch {
    // SPA fallback only for extensionless paths
    if (!path.extname(rel)) file = path.join(uiRoot, "index.html");
    else {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
  }
  try {
    const data = await fs.promises.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-length": data.length,
    });
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

export function resolveDashboardUiRoot(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../dashboard"), // dist/localdash -> dist/dashboard
    path.resolve(here, "../../dist/dashboard"), // src/localdash -> dist/dashboard
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, "index.html")));
}

export function newSessionToken(): string {
  return randomBytes(18).toString("base64url");
}
