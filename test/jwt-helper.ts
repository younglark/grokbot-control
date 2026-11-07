export function jwt(expSec: number, extra: Record<string, unknown> = {}): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ exp: expSec, sub: "u1", email: "t@example.com", ...extra })}.sig`;
}
