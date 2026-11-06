import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuthProvider } from "../src/auth/provider.js";
import { FileCredentialStore, redactCredential } from "../src/auth/store.js";

describe("auth provider (injected fetch)", () => {
  it("begin/poll/refresh with fake fetch; secrets redacted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-auth-"));
    process.env.GBT_CREDENTIALS_DIR = dir;
    let polls = 0;
    const http = {
      fetch: async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith("/auth/poll")) {
          polls++;
          if (polls < 2) return new Response(null, { status: 202 });
          return Response.json({
            access_token: "secret-access",
            refresh_token: "secret-refresh",
            expires_in: 3600,
            account_label: "tester",
          });
        }
        if (u.endsWith("/auth/refresh")) {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.refresh_token, "secret-refresh");
          return Response.json({ access_token: "secret-access-2", refresh_token: "secret-refresh", expires_in: 3600 });
        }
        return new Response("nope", { status: 404 });
      },
    };
    const auth = createAuthProvider({
      kind: "cursor",
      backend: "https://api2.cursor.sh",
      http,
      store: new FileCredentialStore(),
    });
    const begin = await auth.beginLogin();
    assert.match(begin.authorization_url, /loginDeepControl/);
    const pending = await auth.pollLogin(begin.poll_token);
    assert.equal("pending" in pending && pending.pending, true);
    const cred = await auth.pollLogin(begin.poll_token);
    assert.ok("access_token" in cred);
    assert.equal((cred as { access_token: string }).access_token, "secret-access");
    const red = redactCredential(cred as never);
    assert.equal(red.access_token, "[redacted]");
    const who = await auth.whoamiLocal();
    assert.equal(who.has_token, true);
    assert.equal(who.kind, "cursor");
    const refreshed = await auth.refresh();
    assert.equal(refreshed.access_token, "secret-access-2");
    await auth.logout();
    assert.equal((await auth.whoamiLocal()).has_token, false);
  });

  it("rejects untrusted custom backend without confirmation", () => {
    assert.throws(() =>
      createAuthProvider({ kind: "cursor", backend: "https://evil.example" }),
    );
  });
});
