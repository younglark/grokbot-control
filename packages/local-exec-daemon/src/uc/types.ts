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

/** Remaining gaps vs full official UC path. */
export const UC_P2_GAPS = [
  "ack/dedup persistence across restart",
  "backlog 64 / inflight 8 busy semantics under load",
  "generation preempt / ownership race with App",
  "standing/approval/authoritative branches",
  "Credential renew / reject / multi-account scope switch",
  "Capability injection full parity (device/messages/mail)",
] as const;

/** @deprecated use UC_P2_GAPS */
export const UC_P1_GAPS = UC_P2_GAPS;
