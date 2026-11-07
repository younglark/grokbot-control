export { ControlPlane } from "./ops/plane.js";
export { createGrokBotClient, mapConnectError } from "./connect/client.js";
export { createAuthProvider, staticTokenProvider } from "./auth/provider.js";
export { FileCredentialStore, redactCredential } from "./auth/store.js";
export { createMockTransport, createEmptyMockState } from "./testing/mock-transport.js";
export { SCHEMA_VERSION, okResult, failResult } from "./dto/result.js";
export type { ResultEnvelope, Outcome } from "./dto/result.js";
export { GbcError, EXIT } from "./errors.js";
export { buildTools } from "./mcp/tools.js";

export { SyncOps } from "./sync/core.js";
export type { PullInput, LocalInput, AttachmentsInput, Scope } from "./sync/core.js";
export { ATTACHMENT_DOWNLOADER } from "./sync/attachments.js";
export { decodeBody, DECODER } from "./sync/decode.js";
