/**
 * Lightweight checks on the packed dist/dashboard/ tree (no browser).
 * Playwright Chromium UI acceptance was removed from the default suite so
 * `npm test` no longer requires a browser install (release-github.yml does
 * not install Chromium).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDashboardUiRoot } from "../src/localdash/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "dist/dashboard");

function hasUi(): boolean {
  return fs.existsSync(path.join(uiRoot, "index.html"));
}

describe("packed dashboard UI tree", () => {
  it("packed dist/dashboard tree exists after build", (t) => {
    if (!hasUi()) {
      t.skip("dist/dashboard/index.html missing; run npm run build -w grokbot-control");
      return;
    }
    assert.equal(fs.existsSync(path.join(uiRoot, "index.html")), true);
    const assets = path.join(uiRoot, "assets");
    assert.equal(fs.existsSync(assets), true, "dist/dashboard/assets should exist after build");
    assert.ok(
      fs.readdirSync(assets).some((name) => name.endsWith(".js") || name.endsWith(".css")),
      "dist/dashboard/assets should contain packed js/css",
    );
  });

  it("resolveDashboardUiRoot finds the packed tree after build", (t) => {
    if (!hasUi()) {
      t.skip("dist/dashboard/index.html missing; run npm run build -w grokbot-control");
      return;
    }
    const resolved = resolveDashboardUiRoot();
    assert.ok(resolved);
    assert.equal(path.resolve(resolved!), path.resolve(uiRoot));
  });
});
