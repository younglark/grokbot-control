import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEmptyMockState } from "./mock-transport.js";
function statePath() {
    return (process.env.GBT_MOCK_STATE ||
        path.join(process.env.GBT_CREDENTIALS_DIR || path.join(os.homedir(), ".gbc"), "mock-state.json"));
}
function jsonReplacer(_k, v) {
    if (typeof v === "bigint")
        return v.toString();
    // Transcript bodies are bytes; keep them compact and lossless across CLI runs.
    if (v instanceof Uint8Array && !Buffer.isBuffer(v))
        return Buffer.from(v).toString("base64");
    return v;
}
export function loadMockState() {
    const f = statePath();
    try {
        if (fs.existsSync(f)) {
            const raw = JSON.parse(fs.readFileSync(f, "utf8"));
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
    }
    catch {
        /* fallthrough */
    }
    return createEmptyMockState();
}
export function saveMockState(state) {
    const f = statePath();
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, jsonReplacer));
    fs.renameSync(tmp, f);
}
