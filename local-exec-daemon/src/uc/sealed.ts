import * as crypto from "node:crypto";

export type SealedFile = { sandSealedFile: 1; data: string };

export function sealJson(fileKeyB64: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(fileKeyB64, "base64"), iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const data = Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  return JSON.stringify({ sandSealedFile: 1, data } satisfies SealedFile);
}

export function unsealJson(fileKeyB64: string, raw: string): string {
  const j = JSON.parse(raw) as SealedFile;
  if (j.sandSealedFile !== 1 || typeof j.data !== "string") {
    throw new Error("not a sandSealedFile:1 envelope");
  }
  const buf = Buffer.from(j.data, "base64");
  if (buf.length < 28) throw new Error("sealed payload too short");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(fileKeyB64, "base64"), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
