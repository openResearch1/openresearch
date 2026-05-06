# Similarity Progress

## 当前分支

- `graphRAG-relation-similarity`

## 目标

- 在 `graphRAG-relation` 的 GraphRAG/社区分析基础上，新增论文级 subgraph community similarity 能力。
- 比较对象不是整个项目图，而是两篇论文各自按 `article_id` 切出的内部子图。

## 已完成

### 分支整理

- 创建了子分支 `graphRAG-relation-similarity`
- 将论文级 similarity 的实现迁移到该子分支
- `graphRAG-relation` 已回退到这次 similarity 改动之前的状态

### 代码实现

- 在 `packages/opencode/src/tool/atom-graph-prompt/community.ts` 中新增：
  - `compareArticleCommunities(leftId, rightId, options?)`
- 为 community detection 增加 article-scoped 子图能力：
  - 按 `AtomTable.article_id` 过滤 atoms
  - 只保留论文内部边
  - 不污染原有项目级 community cache 语义

### 评分设计落地

- 对两篇论文分别：
  - 构建内部子图
  - 跑 Louvain community detection
- 对每个 community 提取以下特征：
  - semantic centroid embedding
  - atom type 分布
  - evidence type / status 分布
  - relation type 分布
  - `source_type -> target_type` flow 分布
  - size / density / hub ratio
  - keywords
- community pair score 当前由以下分量构成：
  - `semantic`
  - `type`
  - `evidence`
  - `relation`
  - `flow`
  - `structure`
  - `keywords`
- 总分聚合使用双向 best-match：
  - `leftToRight`
  - `rightToLeft`
  - `similarity = (ltr + rtl) / 2`
  - 双向 `coverage`

### 类型定义

- 在 `packages/opencode/src/tool/atom-graph-prompt/types.ts` 中新增：
  - `ArticleCommunityComparisonBreakdown`
  - `ArticleCommunityMatch`
  - `ArticleCommunityDirection`
  - `ArticleCommunitySummary`
  - `ArticleCommunityComparisonReport`

### 测试

- 新增测试文件：
  - `packages/opencode/test/tool/atom-graph-prompt/community-similarity.test.ts`
- 已覆盖场景：
  - 相似论文得分高于不相关论文
  - split / merge community 情况
  - 空论文边界

### 已完成验证

- `bun run typecheck`
- `bun test test/tool/atom-graph-prompt/community-similarity.test.ts`
- `bun test test/tool/atom-graph-prompt/community.test.ts`
- `bun test test/tool/atom-graph-prompt/community-advanced.test.ts`
- `bun test test/tool/atom-graph-prompt/graph-quality.test.ts`

说明：

- 在 embedding API 不可用或受限时，相关 community/quality 测试曾用 simple embedding 环境做过回归确认。
- 在后续 embedding API 恢复可用后，`community-similarity.test.ts` 已再次通过真实 API 路径验证。

### Embedding API 连通性

- 已做 strict probe 验证
- 当前成功结果：

```json
{"model":"openai/text-embedding-3-small@https://api.openai.com/v1","dims":1536}
```

说明：

- 当前远端 embedding API 可连通
- 实际使用模型为 `openai/text-embedding-3-small`
- 返回维度为 `1536`

### 文档同步

- 已更新：
  - `docs/graphRAG-relation-plan.md`
  - `docs/graphRAG-workflow.md`
  - `docs/atom-graph-prompt-progress.md`
- 已新增评分细则文档：
  - `docs/article-community-similarity-scoring.md`

### 真实项目验证

- 已在两个真实项目上完成真实数据评分测试
- 验证过程中发现：
  - 部分项目历史上把“论文目录”作为单个 `article` 导入
  - 导致多个来源论文的 atoms 共享同一个 `article_id`
  - 在做 paper similarity 前，需要先修正 `article_id` 归属

#### Project 1

- 项目：`~/research_project_1`
- 修复后共 3 篇真实论文，每篇各 10 个 atoms：
  - `AutoSchemaKG`
  - `Text-to-LoRA`
  - `Doc-to-LoRA`
- 实际 pairwise similarity：
  - `AutoSchemaKG` vs `Text-to-LoRA` = `0.7661`
  - `AutoSchemaKG` vs `Doc-to-LoRA` = `0.7726`
  - `Text-to-LoRA` vs `Doc-to-LoRA` = `0.7580`

#### Project 2

- 项目：`~/research_project_2`
- 修复后共 4 篇真实论文：
  - `Doc-to-LoRA`（11 atoms）
  - `Long-Document QA / CoST / LITECOST`（14 atoms）
  - `SHINE`（12 atoms）
  - `MemoryBank`（13 atoms）
- 实际 pairwise similarity（按总分降序）：
  - `Doc-to-LoRA` vs `Long-Document QA / CoST` = `0.8514`
  - `Doc-to-LoRA` vs `MemoryBank` = `0.8283`
  - `Doc-to-LoRA` vs `SHINE` = `0.8091`
  - `Long-Document QA / CoST` vs `MemoryBank` = `0.7955`
  - `Long-Document QA / CoST` vs `SHINE` = `0.7862`
  - `MemoryBank` vs `SHINE` = `0.7684`

## 当前状态总结

- 论文级 community similarity 的核心实现已完成
- 类型、测试、文档已同步
- embedding API 已确认可用
- similarity 单测已通过
- 两个真实项目上的评分测试已完成
- 当前评分细则文档已独立整理

## 尚未完成

- 还没有把 similarity 能力封装成更高层 tool / agent 接口
- 还没有输出面向真实项目分析的标准化报告格式
- 当前真实项目结果显示：分数整体偏高，主题区分度仍不够强
- `article_id` 历史脏数据目前仍依赖修复后才能做可靠 paper similarity

## 下一步建议

1. 基于真实项目结果重新调 similarity 权重与分项设计，提升主题区分度
2. 输出标准化真实评分报告：
   - 总分
   - 双向 coverage
   - 社区匹配明细
   - 未覆盖社区
3. 视需要将 similarity 与 article 修复能力暴露为上层 tool

## 备注

- 当前工作区仍有未提交修改。
- 本文档记录进展，提交状态以 git 为准。
