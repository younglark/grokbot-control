# Local execution compatibility boundary

[总览 overview](./overview.md)，[Implementation](../../packages/local-exec-daemon/README.md), [review matrix](../../packages/local-exec-daemon/REVIEW-FIXES.md), [validation history](../../packages/local-exec-daemon/INTEGRATION.md).

`local-exec-daemon` remains the package/bin name and remains private. Node IPC / Electron parentPort are the App-hosted compatibility entry points; UC/box execution semantics remain daemon-owned. Current scope is synthetic/offline validation, not official-install replacement or complete drop-in compatibility. Electron45 lab smoke is not official42 acceptance.

The future headless host will supervise the daemon as a process, not import CLI/MCP into it. [Headless design](../headless/README.md) is a separate lifecycle/authority problem. Shared schema/codegen does not imply shared credentials or permission state.
