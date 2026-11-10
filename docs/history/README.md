# 历史记录（附录）

这里是过程记录，**不代表当前状态**。查当前状态请看 [HANDOFF.md](../HANDOFF.md) 和各主题文档；这里用来追溯“为什么这样做”和当时的原始证据。tNNu / tNNN 是当时的任务轮次编号。

| 文件 | 内容 | 当前状态看哪里 |
|---|---|---|
| [workspace-reorg.md](workspace-reorg.md) | t95u workspace 重组的目录说明与验证 | [architecture.md](../architecture.md) |
| [control-plane-design-review.md](control-plane-design-review.md) | 控制面方案审查与最初分期计划 | [control-plane/requirements.md](../control-plane/requirements.md) |
| [control-plane-status-log.md](control-plane-status-log.md) | 控制面 t43u–t50u 各轮实现与 live 验收原始记录 | [control-plane/implementation-status.md](../control-plane/implementation-status.md) |
| [local-exec-review-rounds.md](local-exec-review-rounds.md) | daemon 逐轮审查修复（原 REVIEW-FIXES.md） | [local-exec/remaining-diffs.md](../local-exec/remaining-diffs.md) |
| [local-exec-integration.md](local-exec-integration.md) | daemon 并入仓库、迁移到生成协议的验证；附旧版包 README | [local-exec/overview.md](../local-exec/overview.md) |
| [scenario-matrix-rounds.md](scenario-matrix-rounds.md) | 场景矩阵 t103u–t113u 逐轮自测/复验说明 | [local-exec/scenario-matrix.md](../local-exec/scenario-matrix.md) |
| [local-exec-evidence-rounds.md](local-exec-evidence-rounds.md) | 从 evidence 文件移出的单轮测试记录和已被推翻的段落 | [local-exec/README.md](../local-exec/README.md#单点证据) |

规则：主文档只写当前状态；新的过程记录不要写进主文档，需要保留时追加到这里。
