# App 0.79.4 daemon 变化（D:78971 内置版本）

全文结论见 [protocol/app-0.79.4-delta.md](../../protocol/app-0.79.4-delta.md) §5。这里只记 daemon 侧的证据和移植。

## 原版

- 0.79.4 `dist/local-exec-daemon/main.cjs` sha256 `c2b2c0ed…6420`，与 0.79.3（`5c1424ed…36be`）同长 3 998 633 字节，76 字节不同。
- 格式化副本 `/workspace/grokbot-node-analysis-0794/daemon.formatted.cjs`（prettier 3.9.10，187 625 行，sha256 `1ca01f7d…7678`）与 0.79.3 副本逐行比，只有 4 行不同：
  - D:16、D:18、D:187625：Sentry debug id（无行为）；
  - **D:78971**：`return jPe(t) ?? jPe("0.79.3") ?? OAt;` → `return jPe(t) ?? jPe("0.79.4") ?? OAt;`（LAt，D:78970–78972）。
- 压缩标识符没有重命名，所以所有既有 D: 行号与名字对 0.79.4 同样成立。`messages-worker.cjs` 字节相同（W: 不变）。

## 行为

LAt 给 VPe（D:78996）提供版本：`SAND_CLIENT_APP_VERSION` 能解析出 x.y.z 时用它，否则用内置字面量，再否则 OAt `"0.1.0"`。
结果进入 mb 头的 `x-cursor-client-version` 与 user-agent `Sand/<v>`（mb D:79034–79044）。

App 托管时 main-core 会先执行 `process.env.SAND_CLIENT_APP_VERSION = gs.version`（`gs` = App `package.json`），所以只有在 env 缺失或不合法时才看得到内置值。

## 移植与测试

- `src/state/connection-exchange.ts`：`BUNDLED_APP_VERSION = "0.79.4"`，`baseVersion()` 用它兜底。
- `test/t166-mb-headers.test.cjs`：兜底值改为 0.79.4，新增「env `0.79.3` 优先于内置值」和 `BUNDLED_APP_VERSION === '0.79.4'` 断言；`test/t159-exchange-obsidian-cp.test.cjs` 同步。
- 门控 harness（`dropin-acceptance` / `dropin-extra`，`DROPIN_ACCEPTANCE=1`）的合成 App env 改为 `SAND_CLIENT_APP_VERSION: '0.79.4'`。2026-11-11 本机运行：acceptance 1/1 通过；extra 9 通过、1 跳过（未设 `DROPIN_ELECTRON`）；线上头为 `0.79.4` / `0.79.4-lab` / `0.79.4-dev`。证据目录 `/tmp/dropin-0794/`（临时）。
