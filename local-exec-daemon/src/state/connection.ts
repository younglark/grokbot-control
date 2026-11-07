import * as path from "node:path";
import { z } from "zod";
import { dataRootFromEnv, readJsonIfExists } from "../util";

const ConnectionSchema = z.object({
  baseUrl: z.string().min(1),
  token: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export type Connection = z.infer<typeof ConnectionSchema>;

export function connectionPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-daemon-connection.json");
}

export async function loadConnection(env: NodeJS.ProcessEnv = process.env): Promise<Connection | null> {
  const raw = await readJsonIfExists<unknown>(connectionPath(env));
  if (raw == null) return null;
  const parsed = ConnectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
