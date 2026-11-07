# Control plane: SDK / CLI / MCP

Implementation: [packages/grokbot-control](../../packages/grokbot-control/README.md). Public name `grokbot-control`, bins `gbc` / `gbc-mcp`, SDK exports unchanged. Auth, operations, sync/attachments, native auth lock and shared CLI/MCP semantics stay together; no forced task layer or new micro-packages.

- [Architecture](architecture.md)
- [Requirements](requirements.md)
- [Implementation status](implementation-status.md)
- [Acceptance](acceptance.md)
- [Auth locking](auth-lock.md)
- [Sync format](sync-format.md)
- [Protocol methods/evidence](../protocol/README.md)

Old one-package root commands in historical plans refer to the control package. Current root `npm run build` / `npm test` orchestrate workspaces; targeted commands use `-w grokbot-control`. Historical evidence/logs are not relabeled as new validation. No full research-doc tree is shipped in the public tarball; its README links to canonical repository docs.
