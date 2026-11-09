import { trace } from "../trace";
import type { Emit, ExecFrameOut } from "./handlers";

export class WriteIterableClosedError extends Error {
  constructor() { super("WritableIterable is closed"); this.name = "WriteIterableClosedError"; }
}
type Writer<T> = { value: T; resolve: () => void; reject: (error: unknown) => void; next?: Writer<T> };
type Reader<T> = { resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void };
/** Ki (D:14896–14972): unbounded linked writes, acknowledged by the NEXT consumer pull.
 * No network receipt, queue limit, disk outbox, or implicit terminal filtering.
 */
export function createWritableIterable<T>() {
  const readers: Reader<T>[] = [];
  let head: Writer<T> | undefined, tail: Writer<T> | undefined, delivered: Writer<T> | undefined;
  let closed = false, failure: unknown;
  const acknowledge = (error?: unknown): void => {
    const writer = delivered; delivered = undefined;
    if (writer) error !== undefined ? writer.reject(error) : writer.resolve();
  };
  const finish = (queuedError: unknown, error?: unknown): void => {
    closed = true;
    if (error !== undefined) failure = error;
    acknowledge(error);
    let writer = head; head = tail = undefined;
    while (writer) { const next = writer.next; writer.reject(error ?? queuedError); writer = next; }
    while (readers.length) {
      const reader = readers.shift()!;
      error !== undefined ? reader.reject(error) : reader.resolve({ done: true, value: undefined });
    }
  };
  return {
    write(value: T): Promise<void> {
      if (closed) return Promise.reject(failure ?? new WriteIterableClosedError());
      const reader = readers.shift();
      if (reader) {
        reader.resolve({ done: false, value });
        if (readers.length > 0) return Promise.resolve();
        return new Promise((resolve, reject) => { delivered = { value, resolve, reject }; });
      }
      return new Promise((resolve, reject) => {
        const writer: Writer<T> = { value, resolve, reject };
        if (tail) tail.next = writer; else head = writer;
        tail = writer;
      });
    },
    throw(error: unknown): void { if (!closed) finish(error, error); },
    close(): void { if (!closed) finish(new WriteIterableClosedError()); },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          acknowledge();
          const writer = head;
          if (writer) {
            head = writer.next; writer.next = undefined;
            if (!head) tail = undefined;
            delivered = writer;
            return Promise.resolve({ done: false, value: writer.value });
          }
          if (closed) return failure !== undefined ? Promise.reject(failure) : Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => { readers.push({ resolve, reject }); });
        },
        throw(error: unknown): Promise<IteratorResult<T>> { finish(error, error); return Promise.resolve({ done: true, value: undefined }); },
        return(): Promise<IteratorResult<T>> { finish(new Error("Iterator was closed")); return Promise.resolve({ done: true, value: undefined }); },
      };
    },
  };
}

/** UC's native consumer is synchronous materialization (D:136337–136348 / 178665–178671).
 * Promise-returning consumers remain an explicit API extension: await admission, never Submit.
 * Box retains its existing bounded admission/legacy wrapper; this does not change Box retry policy.
 */
export async function withExecChannelHeartbeat(requestId: string, msgId: number, consume: Emit,
  run: (write: Emit) => Promise<void>, onConsumerError: () => void = () => {}, intervalMs = 3000): Promise<void> {
  const channel = createWritableIterable<ExecFrameOut>();
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const arm = (): void => {
    trace("hb-arm", { rid: requestId, id: msgId });
    timer = setTimeout(() => {
      trace("hb-fire", { rid: requestId, id: msgId, closed: finished });
      channel.write({ kind: "control", requestId, message: { heartbeat: { id: msgId } } })
        .then(() => { trace("hb-write-resolved", { rid: requestId, id: msgId }); if (!finished) arm(); }, () => {});
    }, intervalMs);
  };
  arm();
  // Observe producer failure here, not in a fire-and-forget rejection. The consumer sees channel errors.
  const producer = (async () => {
    try { await run(frame => channel.write(frame)); }
    catch (error) { if (!(error instanceof WriteIterableClosedError)) channel.throw(error); }
    finally {
      finished = true;
      clearTimeout(timer);
      channel.close(); // D:98187–98193: finally, NOT when streamClose/throw is written.
      trace("exec-channel:producer-finally", { rid: requestId, id: msgId });
    }
  })();
  try {
    for await (const frame of channel) {
      const pending = consume(frame); // A sync throw makes for-await call iterator.return().
      if (pending) await pending; // Only the legacy/test Promise consumer extension.
    }
    await producer;
  } catch (error) {
    // D:136349–136350 cancels the execution context when the reader exits.
    // Do not join an arbitrary external producer body here; return() has settled channel writes.
    onConsumerError();
    throw error;
  }
}
