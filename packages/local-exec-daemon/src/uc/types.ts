/**
 * UserComputer ConnectRPC surface (0.79.3).
 * P2: Connect Watch/Poll/Submit/Withdraw + sealed credential load (lab fake peer).
 */

export type UserComputerHello = {
  label: string;
  localRoot: string;
  terminalsFolder: string;
  standing: string;
  supervised: boolean;
  variant: string;
  serverAuthoritative: boolean;
  capabilities?: Record<string, unknown>;
};

export type UserComputerChannel = {
  backendUrl: string;
  machineId: string;
  credential: string;
  accountScope?: string;
  serverAuthoritative?: boolean;
};

export interface UserComputerTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Remaining gaps vs full official UC path.
 * Note: official FDe ownership does NOT compare discovery.generation numbers
 * (App publishes SAND_LOCAL_EXEC_GENERATION; daemon exits via PID superseded).
 * Do not list "generation compare" as a pending daemon feature.
 */
export const UC_P2_GAPS = [
  "ack/dedup persistence across restart",
  "approval chain beyond exec + outer download/upload (discover-ai-tool/messages/local-tool/url-transfer), standing grants (subject actions), send-mail spend; approval-record writer (not in daemon bundle)",
  "Credential renew / reject / multi-account scope switch",
  "Capability injection full parity (device/messages/mail)",
  "sendKeepAlives / keepAliveDueAt full parity (superviseBacklog 15s/5s covered)",
] as const;

/** @deprecated use UC_P2_GAPS */
export const UC_P1_GAPS = UC_P2_GAPS;
