// @ts-nocheck
/**
 * Explicit simulated backend using Connect createRouterTransport.
 * Never claims live success — ControlPlane must set simulated: true.
 */
import { createRouterTransport } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { GrokBotService } from "#proto-gen/GrokBotService";
import { DashboardService } from "#proto-gen/DashboardService";
/**
 * Fake credential values returned by the mock EnsureSandBox. Tests assert none of
 * these ever reach stdout, stderr, MCP results, or error details.
 */
export const MOCK_ENSURE_SECRETS = {
    networkToken: "FAKE-network-token-6f1c",
    execDaemonAuthToken: "FAKE-exec-daemon-auth-token-91ab",
    execDaemonUrl: "https://exec-daemon.fake-secret.invalid/x",
    vncUrl: "https://vnc.fake-secret.invalid/?token=FAKE-vnc",
    gatewayUrl: "https://gateway.fake-secret.invalid/",
    gatewayToken: "FAKE-gateway-token-3d2e",
    forkVncBaseUrl: "https://fork-vnc.fake-secret.invalid/",
    gatewayPortToken: "FAKE-gateway-port-token-77",
    egressTunnelPortToken: "FAKE-egress-port-token-88",
    forkVncPortToken: "FAKE-fork-vnc-port-token-99",
    cluster: "fake-cluster-secret",
    tenantId: "fake-tenant-secret",
    podId: "fake-pod-secret",
    terminalsFolder: "/fake/terminals-secret",
};
/**
 * Transcript bodies are proto `bytes`. Accept the shapes a persisted mock state can
 * hold after a JSON round trip (base64 string, Buffer JSON, index-keyed object).
 */
function mockBytes(v) {
    if (v == null)
        return undefined;
    if (v instanceof Uint8Array)
        return v;
    if (typeof v === "string")
        return new Uint8Array(Buffer.from(v, "base64"));
    if (Array.isArray(v))
        return Uint8Array.from(v);
    if (typeof v === "object") {
        const o = v;
        if (Array.isArray(o.data))
            return Uint8Array.from(o.data);
        return Uint8Array.from(Object.values(o));
    }
    return undefined;
}
function defaultSandbox() {
    return {
        state: 1,
        recreateStarted: true,
        operationId: "op-mock",
        migrationPhases: [
            { phase: 1, detail: "backing up" },
            { phase: 2, detail: "creating" },
            { phase: 6, detail: "done" },
        ],
    };
}
export function createEmptyMockState() {
    return {
        sandbox: defaultSandbox(),
        bots: [],
        sections: [],
        messages: [],
        statuses: [],
        sessions: [],
        todos: [],
        tasks: [],
        subagents: [],
        transcript: [],
        usageFixture: "normal",
        breakdownFixture: "cents_by_source",
        callCounts: emptyCallCounts(),
        writeCalls: [],
    };
}
export function emptyCallCounts() {
    return {
        listGrokBotAgents: 0,
        listGrokBotAgentStatuses: 0,
        getSandBoxRunState: 0,
        getGrokBotUserRuntimeSettings: 0,
        getSandUsageStatus: 0,
        getGrokBotUsageBreakdown: 0,
        listGrokBotAgentTodos: 0,
        listGrokBotAgentTasks: 0,
        listGrokBotSubagents: 0,
        listGrokBotAgentSessions: 0,
        listGrokBotTranscriptEntries: 0,
    };
}
function counts(state) {
    return (state.callCounts ??= emptyCallCounts());
}
function recordWrite(state, method, req) {
    (state.writeCalls ??= []).push({ method, req });
}
/** Issue #3 simulation: server folds a non-empty title into the display name. */
function mergeTitle(state, name, title) {
    if (state.mergeTitleIntoName && title)
        return { name: `${name} · ${title}`, title: "" };
    return { name, title: title ?? "" };
}
function ts(offsetSec = 0) {
    return { seconds: BigInt(Math.floor(Date.now() / 1000) + offsetSec), nanos: 0 };
}
/** Synthetic GetSandUsageStatus responses. Numbers are fixtures, not live data. */
export function usageFixtureResponse(name) {
    const base = {
        currentPeriodStart: ts(-20 * 24 * 3600),
        nextResetTimestampUtc: ts(10 * 24 * 3600),
        availableBankedResetCount: 0n,
        usesPooledEnterpriseAllowance: false,
        sandTrialCancelable: false,
        isTeamSeat: false,
        isUnified: false,
        billingBrand: 1,
        accountMergePausingBots: false,
    };
    switch (name) {
        case "near_exhausted":
            return {
                ...base,
                usagePercent: 92,
                includedLimitZero: false,
                hasAvailableUsage: true,
                hasNonZeroIncludedLimit: true,
                cursorPlanName: "Pro",
                grokPlanLabel: "SuperGrok",
                availableBankedResetCount: 1n,
            };
        case "exhausted":
            return {
                ...base,
                usagePercent: 100,
                includedLimitZero: false,
                hasAvailableUsage: false,
                hasNonZeroIncludedLimit: true,
                cursorPlanName: "Pro",
                grokPlanLabel: "SuperGrok",
            };
        case "unlimited":
            return {
                ...base,
                includedLimitZero: true,
                hasAvailableUsage: true,
                hasNonZeroIncludedLimit: false,
                cursorPlanName: "Ultra",
                // usagePercent omitted — do not invent a number when there is no included limit
            };
        case "enterprise_shared":
            return {
                ...base,
                usagePercent: 41,
                includedLimitZero: false,
                hasAvailableUsage: true,
                hasNonZeroIncludedLimit: true,
                usesPooledEnterpriseAllowance: true,
                isTeamSeat: true,
                cursorPlanName: "Enterprise",
            };
        case "normal":
        default:
            return {
                ...base,
                usagePercent: 37,
                includedLimitZero: false,
                hasAvailableUsage: true,
                hasNonZeroIncludedLimit: true,
                cursorPlanName: "Pro",
                grokPlanLabel: "SuperGrok",
            };
    }
}
const dayMs = 1700000000000n;
/** Connect/protobuf-es oneof shape accepted by the DashboardService router transport. */
function breakdownOneof(caseName, value) {
    return { breakdown: { case: caseName, value } };
}
/** Synthetic GetGrokBotUsageBreakdown responses. Numbers are fixtures, not live data. */
export function usageBreakdownFixtureResponse(name) {
    switch (name) {
        case "cents_by_bot":
            return breakdownOneof("billedCents", {
                periodStartMs: dayMs,
                periodEndMs: dayMs + 86400000n,
                bySource: [],
                byBot: [
                    { dayMs, botId: "agent-1", cents: 800n },
                    { dayMs, botId: "agent-2", cents: 200n },
                ],
            });
        case "ppm_weekly":
            return breakdownOneof("weeklyLimitPpm", {
                periodStartMs: dayMs,
                periodEndMs: dayMs + 86400000n,
                bySource: [{ dayMs, source: 1, ppm: 225439 }],
                byBot: [{ dayMs, botId: "agent-1", ppm: 225439 }],
            });
        case "ppm_billing":
            return breakdownOneof("billingCyclePpm", {
                periodStartMs: dayMs,
                periodEndMs: dayMs + 86400000n,
                bySource: [{ dayMs, source: 3, ppm: 100000 }],
                byBot: [{ dayMs, botId: "agent-1", ppm: 80000 }],
            });
        case "empty":
            return {};
        case "cents_by_source":
        default:
            return breakdownOneof("billedCents", {
                periodStartMs: dayMs,
                periodEndMs: dayMs + 86400000n,
                bySource: [
                    { dayMs, source: 1, cents: 1234n },
                    { dayMs, source: 2, cents: 50n },
                ],
                byBot: [{ dayMs, botId: "agent-1", cents: 900n }],
            });
    }
}
export function createMockTransport(state) {
    return createRouterTransport(({ service }) => {
        const sandbox = () => (state.sandbox ??= defaultSandbox());
        const startReset = () => {
            const s = sandbox();
            if (s.recreateStarted === false) {
                return {
                    started: false,
                    reason: s.recreateReason ?? "simulated reset refusal",
                    operationId: "",
                };
            }
            s.state = 4;
            return {
                started: true,
                reason: "",
                operationId: s.operationId ?? "op-mock",
            };
        };
        service(GrokBotService, {
            async getSandBoxRunState() {
                counts(state).getSandBoxRunState += 1;
                if (state.failSandbox) {
                    throw new ConnectError("simulated sandbox failure", Code.Unavailable);
                }
                const s = sandbox();
                if (s.wakePendingReads !== undefined) {
                    if (s.wakePendingReads <= 0) {
                        s.state = 3;
                        delete s.wakePendingReads;
                    }
                    else {
                        s.wakePendingReads -= 1;
                    }
                }
                return {
                    state: s.state,
                    imageUpdateAvailable: s.imageUpdateAvailable,
                    image: s.image,
                };
            },
            async ensureSandBox(req, ctx) {
                recordWrite(state, "EnsureSandBox", req ?? {});
                state.lastEnsureRequest = {
                    req: {
                        ...(req?.wake === undefined ? {} : { wake: req.wake }),
                        ...(req?.supportsAsleepBox === undefined
                            ? {}
                            : { supportsAsleepBox: req.supportsAsleepBox }),
                    },
                    parkHeader: ctx?.requestHeader?.get?.("x-sand-box-park") ?? null,
                };
                const s = sandbox();
                if (s.state === 2 && !s.wakeStaysHibernated && req?.wake !== false && req?.supportsAsleepBox !== true) {
                    s.state = 4;
                    s.wakePendingReads = s.wakeReadsUntilRunning ?? 1;
                }
                return {
                    ...MOCK_ENSURE_SECRETS,
                    runState: s.state,
                    imageUpdateAvailable: s.imageUpdateAvailable,
                    image: s.image,
                };
            },
            async recreateSandBox(req) {
                recordWrite(state, "RecreateSandBox", req ?? {});
                return startReset();
            },
            async forceRecreateSandBox(req) {
                recordWrite(state, "ForceRecreateSandBox", req ?? {});
                return startReset();
            },
            async *watchSandBoxMigration(req) {
                const s = sandbox();
                const phases = s.migrationPhases ?? [];
                const from = String(req.fromOffsetKey ?? "");
                const start = /^off-\d+$/.test(from) ? Number(from.slice(4)) + 1 : 0;
                for (let i = Math.max(0, start); i < phases.length; i++) {
                    const phase = phases[i];
                    yield {
                        phase: phase.phase,
                        detail: phase.detail ?? "",
                        atMs: BigInt(Date.now()),
                        offsetKey: `off-${i}`,
                        operationId: s.operationId ?? "op-mock",
                    };
                }
            },
            async listGrokBotAgents() {
                counts(state).listGrokBotAgents += 1;
                if (state.failListAgentsAfter !== undefined) {
                    if (state.failListAgentsAfter <= 0)
                        state.failListAgents = true;
                    else
                        state.failListAgentsAfter -= 1;
                }
                if (state.failListAgents) {
                    throw new ConnectError("simulated list failure", Code.Unavailable);
                }
                const hidden = state.hiddenAgentLists ?? {};
                const agents = state.bots.filter((b) => {
                    const left = hidden[String(b.agentId ?? "")];
                    if (left === undefined || left <= 0)
                        return true;
                    hidden[String(b.agentId ?? "")] = left - 1;
                    return false;
                });
                if ((state.writeCalls ?? []).some((c) => c.method === "DeleteGrokBotAgent") && state.afterDeleteInjectBots) {
                    agents.push(...state.afterDeleteInjectBots);
                }
                return {
                    agents,
                    truncated: Boolean(state.listTruncated),
                    slackConnections: state.slackConnections ?? [],
                    teamsConnections: state.teamsConnections ?? [],
                };
            },
            async createGrokBotTemporalAgent(req) {
                state.createCalls = (state.createCalls ?? 0) + 1;
                if (state.dropNextWrite) {
                    state.dropNextWrite = false;
                    throw new ConnectError("simulated drop", Code.DeadlineExceeded);
                }
                const merged = mergeTitle(state, req.name, req.title);
                const agent = {
                    id: req.agentId,
                    agentId: req.agentId,
                    name: merged.name,
                    description: req.description,
                    title: merged.title,
                    harness: "TEMPORAL",
                    role: "agent",
                    kind: 1,
                    viewerSessionId: `sess-${req.agentId}`,
                    createdAtMs: BigInt(Date.now()),
                    updatedAtMs: BigInt(Date.now()),
                    avatarShape: req.avatarShape,
                    avatarColor: req.avatarColor,
                    legacyAgentId: "",
                    memberAgentIds: [],
                    teamDefaultForViewer: false,
                    suggestions: [],
                    viewerAllowedActions: [],
                    people: [],
                };
                state.bots.push(agent);
                if (state.createVisibilityDelayLists) {
                    (state.hiddenAgentLists ??= {})[req.agentId] = state.createVisibilityDelayLists;
                }
                state.sessions.push({
                    agentId: req.agentId,
                    sessionId: `sess-${req.agentId}`,
                    kind: 1,
                    createdAtMs: BigInt(Date.now()),
                    updatedAtMs: BigInt(Date.now()),
                });
                state.statuses.push({
                    agentId: req.agentId,
                    isRunning: false,
                    live: { agentId: req.agentId, isRunning: false, sessionId: `sess-${req.agentId}` },
                });
                return { agent, harness: 2 };
            },
            async createGrokBotAgent(req) {
                return this.createGrokBotTemporalAgent(req);
            },
            async updateGrokBotAgent(req) {
                const b = state.bots.find((x) => x.agentId === req.id || x.id === req.id);
                if (!b)
                    throw new ConnectError("not found", Code.NotFound);
                if (req.name != null)
                    b.name = req.name;
                if (req.description != null)
                    b.description = req.description;
                if (req.title != null)
                    b.title = req.title;
                if (req.title != null && req.title !== "") {
                    const merged = mergeTitle(state, String(b.name ?? ""), req.title);
                    b.name = merged.name;
                    b.title = merged.title;
                }
                return { agent: b };
            },
            async deleteGrokBotAgent(req) {
                recordWrite(state, "DeleteGrokBotAgent", req ?? {});
                if (state.dropNextWrite) {
                    state.dropNextWrite = false;
                    throw new ConnectError("simulated drop", Code.DeadlineExceeded);
                }
                const id = String(req.id ?? "");
                const fail = state.deleteErrorById?.[id];
                if (fail === "permission") {
                    throw new ConnectError("simulated permission denied", Code.PermissionDenied);
                }
                if (fail === "unknown") {
                    throw new ConnectError("simulated drop", Code.DeadlineExceeded);
                }
                const retain = new Set(state.retainAfterDeleteIds ?? []);
                const match = (b) => String(b.agentId ?? "") !== id && String(b.id ?? "") !== id;
                const before = state.bots.length;
                if (retain.has(id)) {
                    const exists = state.bots.some((b) => !match(b));
                    if (!exists)
                        throw new ConnectError("not found", Code.NotFound);
                    return {};
                }
                state.bots = state.bots.filter((b) => match(b));
                if (state.bots.length === before)
                    throw new ConnectError("not found", Code.NotFound);
                return {};
            },
            async sendGrokBotUserMessage(req) {
                if (state.dropNextWrite) {
                    state.dropNextWrite = false;
                    throw new ConnectError("simulated drop", Code.DeadlineExceeded);
                }
                state.messages.push({ ...req });
                const override = state.sendResponse;
                const refused = override?.delivery === 4;
                if (!refused) {
                    // Schema-shaped row (GrokBotTranscriptEntry): UTF-8 JSON UI entry in `body` bytes.
                    // agentId/sessionId are mock-only filter keys; the wire drops them.
                    state.transcript.push({
                        entryId: `tr-${req.messageId}`,
                        seq: BigInt(state.transcript.length + 1),
                        entryKind: "message",
                        bodyOmitted: false,
                        body: new TextEncoder().encode(JSON.stringify({
                            id: `tr-${req.messageId}`,
                            kind: "message",
                            role: "user",
                            content: req.text,
                            timestampMs: Number(req.sentAtMs ?? 0n),
                        })),
                        agentId: req.agentId,
                        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
                    });
                }
                return override ?? { dispatched: true, delivery: 1 };
            },
            async getGrokBotSendStatus(req) {
                const seq = state.sendStatusSequence;
                if (seq && seq.length > 0)
                    return seq.length > 1 ? seq.shift() : seq[0];
                if (state.sendStatusResponse)
                    return state.sendStatusResponse;
                const found = state.messages.find((m) => m.messageId === req.messageId);
                return {
                    status: found ? 2 : 1,
                    acceptedAtMs: found ? BigInt(Date.now()) : undefined,
                    // Matches the transcript echo row written by sendGrokBotUserMessage.
                    ...(found ? { echoEntryId: `tr-${req.messageId}` } : {}),
                };
            },
            async listGrokBotTranscriptEntries(req) {
                counts(state).listGrokBotTranscriptEntries += 1;
                if (state.failTranscript) {
                    throw new ConnectError("simulated transcript failure", Code.Unavailable);
                }
                state.lastTranscriptRequest = {
                    agentId: req.agentId,
                    sessionId: req.sessionId,
                    limit: req.limit,
                };
                const entries = state.transcript
                    .filter((e) => {
                    const row = e;
                    if (row.agentId && row.agentId !== req.agentId)
                        return false;
                    if (req.sessionId && row.sessionId && row.sessionId !== req.sessionId)
                        return false;
                    return true;
                })
                    .map((e) => (e && e.body != null ? { ...e, body: mockBytes(e.body) } : e));
                return { entries, generation: state.transcriptGeneration ?? 1 };
            },
            async listGrokBotAgentSessions(req) {
                counts(state).listGrokBotAgentSessions += 1;
                if (state.failSessions) {
                    throw new ConnectError("simulated sessions failure", Code.Unavailable);
                }
                return {
                    sessions: state.sessions.filter((s) => s.agentId === req.agentId),
                };
            },
            async listGrokBotAgentStatuses(req) {
                counts(state).listGrokBotAgentStatuses += 1;
                if (state.failStatuses) {
                    throw new ConnectError("simulated status failure", Code.Unavailable);
                }
                const ids = new Set(req.agentIds);
                for (const id of ids) {
                    const seq = state.statusSequence?.[String(id)];
                    if (!seq || seq.length === 0)
                        continue;
                    const next = seq.length > 1 ? seq.shift() : seq[0];
                    state.statuses = state.statuses.filter((s) => String(s.agentId) !== String(id));
                    state.statuses.push({ agentId: id, ...next });
                }
                return {
                    statuses: state.statuses.filter((s) => ids.has(String(s.agentId))),
                };
            },
            async listGrokBotAgentTodos(req) {
                counts(state).listGrokBotAgentTodos += 1;
                if (state.failTodos) {
                    throw new ConnectError("simulated todos failure", Code.Unavailable);
                }
                return {
                    todos: state.todos.filter((t) => {
                        const row = t;
                        return !row.agentId || row.agentId === req.agentId;
                    }),
                };
            },
            async listGrokBotAgentTasks(req) {
                counts(state).listGrokBotAgentTasks += 1;
                if (state.failTasks) {
                    throw new ConnectError("simulated tasks failure", Code.Unavailable);
                }
                return {
                    tasks: state.tasks.filter((x) => {
                        const row = x;
                        return !row.agentId || row.agentId === req.agentId;
                    }),
                };
            },
            async listGrokBotSubagents(req) {
                counts(state).listGrokBotSubagents += 1;
                return {
                    subagents: state.subagents.filter((s) => {
                        const row = s;
                        return !row.agentId || row.agentId === req.agentId;
                    }),
                };
            },
            async interruptGrokBotAgentRun() {
                return { hadActiveRun: true };
            },
            async getGrokBotUserRuntimeSettings() {
                counts(state).getGrokBotUserRuntimeSettings += 1;
                return {
                    settings: {
                        sidebarSections: {
                            sections: state.sections.map((s) => ({
                                id: s.id,
                                name: s.name,
                                agentIds: s.agent_ids,
                            })),
                        },
                        updatedAtMs: BigInt(Date.now()),
                        emailProvider: 0,
                        xToolAccess: 0,
                    },
                };
            },
            async updateGrokBotUserRuntimeSettings(req) {
                state.sidebarWrites = (state.sidebarWrites ?? 0) + 1;
                if (state.forceSidebarConflict) {
                    state.forceSidebarConflict = false;
                    throw new ConnectError("SidebarSectionsSaveConflictError", Code.FailedPrecondition);
                }
                if (state.dropNextWrite) {
                    state.dropNextWrite = false;
                    throw new ConnectError("simulated drop", Code.DeadlineExceeded);
                }
                // Best-effort base check
                if (req.sidebarSectionsBase) {
                    const base = JSON.stringify((req.sidebarSectionsBase.sections ?? []).map((s) => ({
                        id: s.id,
                        name: s.name,
                        agent_ids: s.agentIds,
                    })));
                    const cur = JSON.stringify(state.sections);
                    if (base !== cur) {
                        throw new ConnectError("SidebarSectionsSaveConflictError", Code.FailedPrecondition);
                    }
                }
                if (req.sidebarSections) {
                    state.sections = (req.sidebarSections.sections ?? []).map((s) => ({
                        id: s.id,
                        name: s.name,
                        agent_ids: [...(s.agentIds ?? [])],
                    }));
                }
                return {
                    settings: {
                        sidebarSections: {
                            sections: state.sections.map((s) => ({
                                id: s.id,
                                name: s.name,
                                agentIds: s.agent_ids,
                            })),
                        },
                        updatedAtMs: BigInt(Date.now()),
                        emailProvider: 0,
                        xToolAccess: 0,
                    },
                };
            },
        });
        // Official DashboardService read fixture only. No write RPCs are implemented.
        service(DashboardService, {
            async getSandUsageStatus() {
                counts(state).getSandUsageStatus += 1;
                const fixture = state.usageFixture ?? "normal";
                if (fixture === "failure") {
                    throw new ConnectError("simulated usage failure", Code.Unavailable);
                }
                return usageFixtureResponse(fixture);
            },
            async getGrokBotUsageBreakdown(req) {
                counts(state).getGrokBotUsageBreakdown += 1;
                state.lastUsageBreakdownRequest = req ?? {};
                const fixture = state.breakdownFixture ?? "cents_by_source";
                if (fixture === "failure") {
                    throw new ConnectError("simulated breakdown failure", Code.Unavailable);
                }
                return usageBreakdownFixtureResponse(fixture);
            },
        });
    });
}
