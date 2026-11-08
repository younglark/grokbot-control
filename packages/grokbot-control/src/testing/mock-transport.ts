// @ts-nocheck
/**
 * Explicit simulated backend using Connect createRouterTransport.
 * Never claims live success — ControlPlane must set simulated: true.
 */
import { createRouterTransport } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { GrokBotService } from "#proto-gen/GrokBotService";
import type { SidebarSection } from "../dto/types.js";

export type MockSandboxState = {
  state: number;
  imageUpdateAvailable?: boolean;
  image?: { registryTag?: string; staticSnapshotPath?: string };
  recreateStarted?: boolean;
  recreateReason?: string;
  operationId?: string;
  migrationPhases?: Array<{ phase: number; detail?: string }>;
};

export type MockState = {
  bots: Array<Record<string, unknown>>;
  sections: SidebarSection[];
  /** Force next sidebar update to conflict. */
  forceSidebarConflict?: boolean;
  /** Drop next write response (simulate unknown). */
  dropNextWrite?: boolean;
  messages: Array<Record<string, unknown>>;
  statuses: Array<Record<string, unknown>>;
  sessions: Array<Record<string, unknown>>;
  todos: unknown[];
  tasks: unknown[];
  subagents: unknown[];
  transcript: unknown[];
  sandbox: MockSandboxState;
};

function defaultSandbox(): MockSandboxState {
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

export function createEmptyMockState(): MockState {
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
  };
}

export function createMockTransport(state: MockState) {
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
        const s = sandbox();
        return {
          state: s.state,
          imageUpdateAvailable: s.imageUpdateAvailable,
          image: s.image,
        };
      },
      async recreateSandBox() {
        return startReset();
      },
      async forceRecreateSandBox() {
        return startReset();
      },
      async *watchSandBoxMigration(req) {
        const s = sandbox();
        const phases = s.migrationPhases ?? [];
        const from = String(req.fromOffsetKey ?? "");
        const start = /^off-\d+$/.test(from) ? Number(from.slice(4)) + 1 : 0;
        for (let i = Math.max(0, start); i < phases.length; i++) {
          const phase = phases[i]!;
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
        return { agents: state.bots, truncated: false, slackConnections: [], teamsConnections: [] };
      },
      async createGrokBotTemporalAgent(req) {
        if (state.dropNextWrite) {
          state.dropNextWrite = false;
          throw new ConnectError("simulated drop", Code.DeadlineExceeded);
        }
        const agent = {
          id: req.agentId,
          agentId: req.agentId,
          name: req.name,
          description: req.description,
          title: req.title,
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
        return this.createGrokBotTemporalAgent!(req);
      },
      async updateGrokBotAgent(req) {
        const b = state.bots.find((x) => x.agentId === req.id || x.id === req.id);
        if (!b) throw new ConnectError("not found", Code.NotFound);
        if (req.name != null) b.name = req.name;
        if (req.description != null) b.description = req.description;
        if (req.title != null) b.title = req.title;
        return { agent: b };
      },
      async deleteGrokBotAgent(req) {
        if (state.dropNextWrite) {
          state.dropNextWrite = false;
          throw new ConnectError("simulated drop", Code.DeadlineExceeded);
        }
        const before = state.bots.length;
        state.bots = state.bots.filter((b) => b.agentId !== req.id && b.id !== req.id);
        if (state.bots.length === before) throw new ConnectError("not found", Code.NotFound);
        return {};
      },
      async sendGrokBotUserMessage(req) {
        if (state.dropNextWrite) {
          state.dropNextWrite = false;
          throw new ConnectError("simulated drop", Code.DeadlineExceeded);
        }
        state.messages.push({ ...req });
        state.transcript.push({
          id: `tr-${req.messageId}`,
          kind: "user",
          plaintext: req.text,
        });
        return { dispatched: true, delivery: 1 };
      },
      async getGrokBotSendStatus(req) {
        const found = state.messages.find((m) => m.messageId === req.messageId);
        return {
          status: found ? 2 : 0,
          acceptedAtMs: found ? BigInt(Date.now()) : undefined,
        };
      },
      async listGrokBotTranscriptEntries() {
        return { entries: state.transcript, generation: 1 };
      },
      async listGrokBotAgentSessions(req) {
        return {
          sessions: state.sessions.filter((s) => s.agentId === req.agentId),
        };
      },
      async listGrokBotAgentStatuses(req) {
        const ids = new Set(req.agentIds);
        return {
          statuses: state.statuses.filter((s) => ids.has(String(s.agentId))),
        };
      },
      async listGrokBotAgentTodos() {
        return { todos: state.todos };
      },
      async listGrokBotAgentTasks() {
        return { tasks: state.tasks };
      },
      async listGrokBotSubagents() {
        return { subagents: state.subagents };
      },
      async interruptGrokBotAgentRun() {
        return { hadActiveRun: true };
      },
      async getGrokBotUserRuntimeSettings() {
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
          const base = JSON.stringify(
            (req.sidebarSectionsBase.sections ?? []).map((s: { id: string; name: string; agentIds: string[] }) => ({
              id: s.id,
              name: s.name,
              agent_ids: s.agentIds,
            })),
          );
          const cur = JSON.stringify(state.sections);
          if (base !== cur) {
            throw new ConnectError("SidebarSectionsSaveConflictError", Code.FailedPrecondition);
          }
        }
        if (req.sidebarSections) {
          state.sections = (req.sidebarSections.sections ?? []).map(
            (s: { id: string; name: string; agentIds: string[] }) => ({
              id: s.id,
              name: s.name,
              agent_ids: [...(s.agentIds ?? [])],
            }),
          );
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
  });
}
