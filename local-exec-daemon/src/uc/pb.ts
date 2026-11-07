/** Minimal protobuf / Connect envelope helpers (no codegen). */

export function varint(n: number): Buffer {
  const a: number[] = [];
  let x = n >>> 0;
  while (x > 0x7f) {
    a.push((x & 0x7f) | 0x80);
    x >>>= 7;
  }
  a.push(x);
  return Buffer.from(a);
}

export function encStr(fn: number, s: string): Buffer {
  const b = Buffer.from(String(s), "utf8");
  return Buffer.concat([varint((fn << 3) | 2), varint(b.length), b]);
}

export function encVarint(fn: number, n: number): Buffer {
  return Buffer.concat([varint((fn << 3) | 0), varint(n >>> 0)]);
}

export function encBool(fn: number, v: boolean): Buffer {
  return encVarint(fn, v ? 1 : 0);
}

export function encBytes(fn: number, b: Buffer): Buffer {
  return Buffer.concat([varint((fn << 3) | 2), varint(b.length), b]);
}

export function encMsg(fn: number, m: Buffer): Buffer {
  return encBytes(fn, m);
}

export function encInt64(fn: number, n: number | bigint): Buffer {
  let x = BigInt(n);
  const a: number[] = [];
  if (x < 0n) x = 0n;
  while (x > 0x7fn) {
    a.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  a.push(Number(x));
  return Buffer.concat([varint((fn << 3) | 0), Buffer.from(a)]);
}

function readVarint(buf: Buffer, start: number): [bigint, number] {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    const at = start + i;
    if (at >= buf.length) throw new Error("truncated varint");
    const b = buf[at];
    if (i === 9 && b > 1) throw new Error("varint overflow");
    value |= BigInt(b & 127) << BigInt(i * 7);
    if (!(b & 128)) return [value, at + 1];
  }
  throw new Error("varint overflow");
}
export type PbField = { t: "v" | "b" | "f32" | "f64"; v: number | bigint | Buffer };
export type PbFields = Record<number, PbField[]>;
export function decodeFields(buf: Buffer, out: PbFields = {}): PbFields {
  let i = 0;
  while (i < buf.length) {
    const [tag, j] = readVarint(buf, i); i = j;
    const fn = Number(tag >> 3n), wt = Number(tag & 7n);
    if (fn < 1 || fn > 536870911) throw new Error("invalid field number");
    if (wt === 0) {
      const [v, k] = readVarint(buf, i); i = k;
      (out[fn] ||= []).push({ t: "v", v: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v });
    } else if (wt === 2) {
      const [len, k] = readVarint(buf, i); i = k;
      if (len > BigInt(buf.length - i)) throw new Error("truncated field");
      const end = i + Number(len);
      (out[fn] ||= []).push({ t: "b", v: buf.subarray(i, end) }); i = end;
    } else if (wt === 5 || wt === 1) {
      const size = wt === 5 ? 4 : 8;
      if (i + size > buf.length) throw new Error("truncated fixed field");
      (out[fn] ||= []).push({ t: wt === 5 ? "f32" : "f64", v: buf.subarray(i, i + size) }); i += size;
    } else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}

export function firstStr(fields: PbFields, fn: number): string {
  const a = fields[fn];
  if (!a?.length) return "";
  const it = a[0];
  return it.t === "b" ? (it.v as Buffer).toString("utf8") : "";
}

export function firstVarint(fields: PbFields, fn: number): number | undefined {
  const a = fields[fn];
  if (!a?.length) return undefined;
  const it = a[0];
  return it.t === "v" ? (it.v as number) : undefined;
}

/** Connect streaming envelope: 1 byte flags + 4 byte BE length + payload. */
export function envelope(msg: Buffer, end = false): Buffer {
  const flags = end ? 2 : 0;
  const h = Buffer.alloc(5);
  h[0] = flags;
  h.writeUInt32BE(msg.length, 1);
  return Buffer.concat([h, msg]);
}

export function endEnvelope(obj: unknown): Buffer {
  const b = Buffer.from(JSON.stringify(obj || {}), "utf8");
  return envelope(b, true);
}

/** Unary application/proto is raw protobuf, NEVER guessed as streaming envelope. */
export function unwrapConnectBody(buf: Buffer): Buffer { return buf; }

/** Parse successive Connect envelopes from a stream buffer. */
export function takeEnvelopes(buf: Buffer): { messages: Buffer[]; rest: Buffer; ended: boolean; endError?: string } {
  const messages: Buffer[] = [];
  let i = 0;
  let ended = false;
  let endError: string | undefined;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    if (i + 5 + len > buf.length) break;
    if (len > 8 * 1024 * 1024) throw new Error("Connect envelope exceeds limit");
    if (flags !== 0 && flags !== 2) throw new Error("unsupported Connect envelope flags");
    const payload = buf.subarray(i + 5, i + 5 + len);
    i += 5 + len;
    if (flags & 2) {
      ended = true;
      const meta = JSON.parse(payload.toString("utf8"));
      endError = typeof meta?.error?.code === "string" ? meta.error.code : undefined;
      break;
    }
    if (payload.length) messages.push(payload);
  }
  return { messages, rest: buf.subarray(i), ended, endError };
}
