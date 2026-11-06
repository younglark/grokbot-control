import { createAuthProvider, staticTokenProvider } from "../auth/provider.js";
import type { AuthKind } from "../auth/types.js";
import { ControlPlane } from "../ops/plane.js";
import { createMockTransport } from "../testing/mock-transport.js";
import type { MockState } from "../testing/mock-transport.js";
import { loadMockState, saveMockState } from "../testing/mock-persist.js";

export type CliGlobal = {
  json: boolean;
  allowWrites: boolean;
  dryRun: boolean;
  baseUrl: string;
  authKind: AuthKind;
  mock: boolean;
  trustBackend: boolean;
};

export function parseGlobals(argv: string[]): { globals: CliGlobal; rest: string[] } {
  const globals: CliGlobal = {
    json: false,
    allowWrites: false,
    dryRun: false,
    baseUrl: process.env.GBT_BASE_URL || "https://api2.cursor.sh",
    authKind: (process.env.GBT_AUTH_KIND as AuthKind) || "cursor",
    mock: process.env.GBT_MOCK === "1",
    trustBackend: process.env.GBT_TRUST_BACKEND === "1",
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") globals.json = true;
    else if (a === "--allow-writes") globals.allowWrites = true;
    else if (a === "--dry-run") globals.dryRun = true;
    else if (a === "--mock") globals.mock = true;
    else if (a === "--trust-backend") globals.trustBackend = true;
    else if (a === "--base-url") globals.baseUrl = argv[++i] || "";
    else if (a.startsWith("--base-url=")) globals.baseUrl = a.slice("--base-url=".length);
    else if (a === "--auth-kind") globals.authKind = (argv[++i] as AuthKind) || "cursor";
    else if (a.startsWith("--auth-kind=")) globals.authKind = a.slice("--auth-kind=".length) as AuthKind;
    else rest.push(a);
  }
  return { globals, rest };
}

export function flag(rest: string[], name: string): string | undefined {
  const idx = rest.indexOf(name);
  if (idx >= 0) return rest[idx + 1];
  const pref = rest.find((x) => x.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : undefined;
}

export function hasFlag(rest: string[], name: string): boolean {
  return rest.includes(name) || rest.some((x) => x.startsWith(`${name}=`));
}

let sharedMockState: MockState | undefined;

export function buildPlane(globals: CliGlobal): ControlPlane {
  if (globals.mock) {
    sharedMockState ??= loadMockState();
    return new ControlPlane({
      baseUrl: "mock://gbc",
      transport: createMockTransport(sharedMockState),
      simulated: true,
      auth: staticTokenProvider({
        kind: globals.authKind,
        backend: globals.baseUrl,
        accessToken: "mock-token",
      }),
    });
  }
  const auth = createAuthProvider({
    kind: globals.authKind,
    backend: globals.baseUrl,
    trustCustomBackend: globals.trustBackend,
  });
  return new ControlPlane({
    baseUrl: globals.baseUrl,
    auth,
    simulated: false,
  });
}

export function persistMockState(): void {
  if (sharedMockState) saveMockState(sharedMockState);
}

export function getMockState(): MockState | undefined {
  return sharedMockState;
}
