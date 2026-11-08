import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MockState } from "./mock-transport.js";
import { createEmptyMockState } from "./mock-transport.js";

function statePath(): string {
  return (
    process.env.GBT_MOCK_STATE ||
    path.join(process.env.GBT_CREDENTIALS_DIR || path.join(os.homedir(), ".gbc"), "mock-state.json")
  );
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  return v;
}

export function loadMockState(): MockState {
  const f = statePath();
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf8")) as MockState;
      return {
        ...createEmptyMockState(),
        ...raw,
        bots: raw.bots ?? [],
        sections: raw.sections ?? [],
        messages: raw.messages ?? [],
        statuses: raw.statuses ?? [],
        sessions: raw.sessions ?? [],
        todos: raw.todos ?? [],
        tasks: raw.tasks ?? [],
        subagents: raw.subagents ?? [],
        transcript: raw.transcript ?? [],
        sandbox: raw.sandbox ?? createEmptyMockState().sandbox,
      };
    }
  } catch {
    /* fallthrough */
  }
  return createEmptyMockState();
}

export function saveMockState(state: MockState): void {
  const f = statePath();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, jsonReplacer));
  fs.renameSync(tmp, f);
}
