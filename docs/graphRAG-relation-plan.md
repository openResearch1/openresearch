# graphRAG-relation 研发计划

## 背景

当前 `graphRAG` 主线已经具备以下基础能力：

- 图遍历与 GraphRAG Prompt 构建
- 语义搜索、混合检索、评分与 token 预算
- 社区检测、社区查询、社区过滤
- 项目范围隔离与真实 embedding 接入

当前系统已经能回答“图里有什么”，但还不够擅长回答以下问题：

- 哪些社区是噪声，哪些社区值得保留
- 一个研究主题是如何演化的
- 图中哪些关系可能缺失
- 某个社区下一步可能延伸出哪些新节点
- 当前图谱整体质量如何，是否适合继续用于检索与推理

因此下一条研发线聚焦为：**关系分析与社区增强**。

---

## 分支目标

建议在 `graphRAG-relation` 分支中推进以下能力：

1. 社区剪枝
2. 社区演化追踪
3. 潜在关系发掘
4. 潜在延伸节点发掘
5. 图谱质量评估指标

该分支不再以更换底层存储为目标，默认继续基于当前 SQLite 图数据与现有 GraphRAG 主链路推进。

---

## 总体原则

1. 先做分析层，再做推荐层
2. 先做可解释规则，再逐步引入语义评分
3. 先产出稳定 API，再接入工具与 agent
4. 优先服务研究场景，不以 benchmark 为主导
5. 尽量复用现有 `community.ts`、`hybrid.ts`、`types.ts`

---

## 当前进度快照

- ✅ `docs/graphRAG-workflow.md` 已建立，并作为 relation 分支的总骨架持续维护
- ✅ 真实 embedding API 仍保留在分支中，并在父分支基础上增加了 strict mode 与 retry 控制
- ✅ `community-prune.ts` 已实现社区级规则剪枝，默认基线已落在 `DEFAULT_PRUNE_OPTIONS`
- ✅ `community-prune.test.ts` 与 `test/eval/longmemeval/pruning-eval.ts` 已落地
- ✅ `atom-quality.ts` / `atom-rerank.ts` 已落地，`hybrid.ts` 已接入 atom-wise quality + query-aware reranking
- 🟡 `graph-quality.ts` 已落地首版 assessment，覆盖结构 / 语义 / 研究 / 稳定性基础指标
- ✅ 论文级 community similarity 已落地：按 `article_id` 构建内部子图、分别做社区检测，并输出对称 similarity + 双向 coverage
- ✅ 已在 `research_project_1` 与 `research_project_2` 上完成真实 paper similarity 验证，并补充了评分细则文档
- ⚠️ 社区 pruning 目前主要用于评估和手动过滤，还没有默认接入主检索 workflow
- ⚠️ graph assessment 已有独立模块，但还没有默认接入 workflow 质量门控
- ⚠️ 真实项目结果显示 paper similarity 分数整体偏高，主题区分度仍需继续增强
- 🔲 潜在关系发掘、潜在延伸节点发掘、社区演化追踪仍未实现

---

## 范围

### 本分支包含

- workflow 构建与持续完善
- 社区质量分析
- 社区剪枝
- 演化分析
- 缺失关系候选发现
- 潜在延伸节点候选发现
- 图谱质量报告
- 对应测试与文档

### 本分支暂不包含

- Neo4j 替换或再次引入为默认后端
- 独立可视化系统
- 完整 temporal database 方案
- Memory Subagent 正式实现

---

## 现有基础

当前可以直接复用的模块：

- `packages/opencode/src/tool/atom-graph-prompt/community.ts`
- `packages/opencode/src/tool/atom-graph-prompt/community-prune.ts`
- `packages/opencode/src/tool/atom-graph-prompt/hybrid.ts`
- `packages/opencode/src/tool/atom-graph-prompt/atom-quality.ts`
- `packages/opencode/src/tool/atom-graph-prompt/atom-rerank.ts`
- `packages/opencode/src/tool/atom-graph-prompt/traversal.ts`
- `packages/opencode/src/tool/atom-graph-prompt/scoring.ts`
- `packages/opencode/src/tool/atom-graph-prompt/types.ts`

当前已有的社区指标：

- `size`
- `density`
- `dominantType`
- `summary`
- `keywords`

当前仍缺少：

- 社区剪枝默认接入主检索链路
- 图谱质量评估默认接入检索前质量门控
- 社区时间切片与演化追踪
- 缺失关系建议
- 延伸节点建议
- 可比较的质量评估报告

---

## 里程碑

## Milestone 0: Workflow 构建与持续完善

### 目标

把当前 GraphRAG 从“若干独立能力”整理为一条从起始到结束的完整流程，并在后续关系增强研发中持续维护这条 workflow。

### 产物

- `docs/graphRAG-workflow.md`
- 明确区分已实现与未实现环节
- 明确 GraphRAG 与 relation 分支功能的接入点

### 首版内容

1. 研究初始化
2. 原子化建图
3. GraphRAG 预处理层
4. 用户查询进入
5. GraphRAG 检索执行
6. 生成研究回答/总结
7. 结果回写与图谱演化
8. 高阶分析与下一步建议

### 后续完善方向

- 将社区剪枝接入 workflow 的预处理层
- 将图谱质量评估接入 workflow 的质量门控层
- 将潜在关系发掘和延伸节点发掘接入 workflow 的建议回写层
- 将社区演化追踪接入 workflow 的时间维演化层
- 逐步补齐“已实现 / 未实现 / 下一步”的状态说明

### 验证点

- workflow 是否覆盖了从研究输入到图谱更新的完整闭环
- workflow 是否能作为 relation 分支后续研发的挂载骨架
- workflow 文档是否与真实代码能力保持同步

---

## Milestone 1: 社区剪枝 ✅

### 目标

识别并剔除低价值、低密度、低解释性的社区，提升检索与分析的稳定性。

### 当前实现

- 已实现 `community-prune.ts`
- 已实现 `pruneCommunities()` / `scoreCommunity()` / `summarizePruning()`
- 已在 `types.ts` 中补齐 `CommunityPruneOptions`、`PrunedCommunity`、`CommunityPruneResult`
- 已有 `community-prune.test.ts` 覆盖核心规则
- 已有 `test/eval/longmemeval/pruning-eval.ts` 用于真实评估
- 当前默认策略为激进配置，但仍未默认挂到主检索 workflow

### 首版策略

基于规则进行剪枝：

- 最小社区大小
- 最小社区密度
- 最小内部边数
- 最小有效关键词数量
- 最大单节点主导比例

### 当前默认基线

当前已实现版本中，默认 pruning 基线采用 **激进配置**：

- `minSize=5`
- `minDensity=0.05`
- `minInternalEdges=4`
- `minKeywords=3`
- `maxHubRatio=0.65`

采用激进配置的原因：

- 在不降低 LongMemEval 准确率的前提下，节点压缩效果最好
- 社区评分提升幅度最大
- 更适合作为后续 relation / quality / atom-wise 工作的默认净化基线

默认配置代码位置：

- `packages/opencode/src/tool/atom-graph-prompt/community-prune.ts#DEFAULT_PRUNE_OPTIONS`

### 输出

- 保留社区列表
- 被剪枝社区列表
- 每个社区的剪枝原因

### 建议 API

```ts
pruneCommunities(options): Promise<{
  kept: Community[]
  removed: PrunedCommunity[]
  decisions: PrunedCommunity[]
}>
```

### 验证点

- 噪声社区是否被有效移除
- 剪枝后社区检索结果是否更稳定
- 剪枝规则是否足够可解释
- 默认激进配置是否持续保持“结构改善但不伤害准确率”

---

## Milestone 2: 图谱质量评估指标 🟡

### 目标

为图谱、社区和检索结果建立可量化的质量指标，给后续优化和推荐提供基线。

### 指标分组

#### 结构质量

- `totalCommunities`
- `avgCommunitySize`
- `avgDensity`
- `isolatedAtomRatio`
- `bridgeAtomRatio`

#### 语义质量

- `intraCommunitySimilarity`
- `interCommunitySeparation`
- `summaryCoherence`
- `keywordUniqueness`

#### 研究质量

- `typeCoverage`
- `evidenceCoverage`
- `verificationCoverage`
- `contradictionExposure`

#### 稳定性质量

- `pruneRetentionRatio`
- `relationSuggestionConfidence`
- `extensionSuggestionConfidence`

### 建议 API

```ts
evaluateGraphQuality(options): Promise<GraphQualityReport>
```

### 当前实现

- 已实现 `packages/opencode/src/tool/atom-graph-prompt/graph-quality.ts`
- 已实现 `evaluateGraphQuality()` 独立 API
- 已实现首版指标：
  - 结构质量：`totalCommunities` / `avgCommunitySize` / `avgDensity` / `isolatedAtomRatio` / `bridgeAtomRatio`
  - 语义质量：`intraCommunitySimilarity` / `interCommunitySeparation` / `summaryCoherence` / `keywordUniqueness`
  - 研究质量：`typeCoverage` / `evidenceCoverage` / `verificationCoverage` / `contradictionExposure`
  - 稳定性质量：`pruneRetentionRatio`
- 已补 `graph-quality.test.ts`

### 当前仍未完成

- 质量报告还没有默认接入 workflow 质量门控
- `relationSuggestionConfidence` / `extensionSuggestionConfidence` 仍为占位值
- 后续仍需在真实研究项目上验证指标解释力

### 首版优先指标

- `avgDensity`
- `isolatedAtomRatio`
- `intraCommunitySimilarity`
- `typeCoverage`
- `verificationCoverage`

---

## Milestone 2.5: 论文子图 Community Similarity ✅

### 目标

比较两篇论文在同一 research project 内部的知识组织是否接近，且比较对象不是整图，而是各自 `article_id` 对应的内部子图社区结构。

### 当前实现

- 已在 `packages/opencode/src/tool/atom-graph-prompt/community.ts` 落地 `compareArticleCommunities()`
- `detectCommunities()` 已支持临时 article-scoped 子图检测，但只对项目级检测保留原缓存语义
- 评分流程：
  - 先按 `article_id` 切论文内部子图
  - 对两篇论文分别做 Louvain 社区检测
  - 对每个社区提取语义 / 类型 / 证据 / 关系 / type-flow / 结构 / 关键词特征
  - 计算 community-to-community pair score
  - 用双向 best-match 聚合成对称总分
- 输出：
  - 总体 `similarity`
  - `leftToRight` / `rightToLeft` 方向分数
  - 双向 `coverage`
  - 每个社区的最佳匹配及分项 breakdown

### 当前 metric 组成

- `semantic`
- `type`
- `evidence`
- `relation`
- `flow`
- `structure`
- `keywords`

### 默认聚合原则

- 不使用 Hungarian 作为主聚合器
- 使用双向 best-match：
  - 更稳地处理社区拆分 / 合并不一致
  - 天然兼容未来方向性覆盖分析

### 建议 API

```ts
compareArticleCommunities(leftArticleId, rightArticleId, options?): Promise<ArticleCommunityComparisonReport>
```

### 测试

- 已新增 `packages/opencode/test/tool/atom-graph-prompt/community-similarity.test.ts`
- 覆盖：
  - 相似论文 vs 不相关论文
  - split / merge community 场景
  - 空论文边界

### 评分细则文档

- `docs/article-community-similarity-scoring.md`

### 真实项目验证

- 已在 `~/research_project_1` 与 `~/research_project_2` 上完成真实数据评分测试
- 验证过程中发现：如果历史数据把“论文目录”错误记录成单个 `article`，需要先修复 `article_id` 归属，才能得到可靠的 paper similarity 结果
- 当前结果说明：
  - 相似度能力已经能稳定运行在真实项目上
  - 但当前权重更偏结构相似，主题级区分度仍不够强

### 后续仍可增强

- 支持方向性覆盖报告的上层 tool/agent 暴露
- 引入 Hungarian 作为解释型匹配视图，而非主评分器
- 把 paper similarity 接到更高层的 paper bench / research analysis workflow
- 结合真实项目结果继续调权重，提高同主题论文的相对区分度

---

## Milestone 3: 潜在关系发掘

### 目标

找出“图中应该存在但尚未建立”的关系候选。

### 候选来源

- 高语义相似度但无边连接的 atom 对
- 共享邻居较多的 atom 对
- 同社区中长期共现但无显式关系的 atom 对
- 时间上接近且类型兼容的 atom 对
- 已知关系模式的结构补全

### 建议关系类型推断

- `fact -> method`
- `method -> verification`
- `fact -> verification`
- `method -> method`
- `verification -> verification`

### 建议输出

- `sourceAtomId`
- `targetAtomId`
- `suggestedRelationType`
- `confidence`
- `evidence`
- `why`

### 建议 API

```ts
discoverRelationCandidates(options): Promise<RelationCandidate[]>
```

### 评分维度

- semantic similarity
- shared neighbors
- same community bonus
- temporal proximity
- type compatibility
- existing relation pattern prior

---

## Milestone 4: 潜在延伸节点发掘

### 目标

识别某个社区或主题下一步可能延伸出的新节点类型和方向。

### 首版场景

#### 关系缺口型

例如：

- 社区已有 `fact` 与 `method`，但缺 `verification`
- 社区已有大量验证结论，但缺反例或约束条件

#### 桥接扩展型

例如：

- 两个社区在关键词和邻居上高度接近
- 但中间缺一个桥接 atom 或中间方法节点

### 建议输出

- `targetCommunityId`
- `suggestedAtomType`
- `suggestedTitle`
- `rationale`
- `supportingAtoms`
- `confidence`

### 建议 API

```ts
discoverExtensionCandidates(options): Promise<ExtensionCandidate[]>
```

### 目标价值

- 帮助研究人员发现图谱空白
- 帮助 agent 主动提出后续研究方向

---

## Milestone 5: 社区演化追踪

### 目标

回答“一个社区是如何形成、扩张、转向和稳定下来的”。

### 首版方案

先基于现有时间字段做轻量版：

- 使用 `time_created`
- 按时间窗口切片
- 每个窗口独立计算社区特征
- 用 atom overlap / keyword overlap 对齐社区

### 关注问题

- 社区何时开始出现
- 社区何时快速扩张
- 社区主导类型是否发生变化
- 哪些 atom 是演化转折点
- 哪些关系推动了主题收敛或分裂

### 建议 API

```ts
traceCommunityEvolution(options): Promise<CommunityEvolution[]>
```

### 后续可扩展方向

- 接 temporal thinking 主链路
- 输出社区时间线摘要
- 接可视化层

---

## 推荐实现顺序

建议按以下顺序推进：

1. 社区剪枝
2. 图谱质量评估指标
3. 潜在关系发掘
4. 潜在延伸节点发掘
5. 社区演化追踪

原因：

- 剪枝和质量指标最容易先落地
- 潜在关系发掘对实际研究辅助价值最高
- 演化追踪最依赖时间建模，适合在前几项稳定后再做

---

## 建议新增模块

建议新增文件：

- `packages/opencode/src/tool/atom-graph-prompt/relation-analysis.ts`
- `packages/opencode/src/tool/atom-graph-prompt/community-evolution.ts`

建议扩展：

- `packages/opencode/src/tool/atom-graph-prompt/types.ts`
- `packages/opencode/src/tool/atom-graph-prompt/community.ts`
- `packages/opencode/src/tool/atom-graph-prompt/hybrid.ts`

---

## 建议新增类型

```ts
interface PrunedCommunity {
  community: Community
  pruned: boolean
  reason?: string
}

interface RelationCandidate {
  sourceAtomId: string
  targetAtomId: string
  suggestedRelationType: RelationType
  confidence: number
  evidence: string[]
  why: string
}

interface ExtensionCandidate {
  targetCommunityId: string
  suggestedAtomType: AtomType
  suggestedTitle: string
  rationale: string
  supportingAtoms: string[]
  confidence: number
}

interface CommunityEvolution {
  communityId: string
  snapshots: CommunitySnapshot[]
  growth: number
  drift: number
  turningPoints: string[]
}

interface GraphQualityReport {
  structure: Record<string, number>
  semantic: Record<string, number>
  research: Record<string, number>
  stability: Record<string, number>
}
```

---

## 测试计划

建议新增测试：

- `relation-analysis.test.ts`
- `community-evolution.test.ts`

建议覆盖：

- 小社区噪声剪枝
- 稠密社区保留
- 缺失关系候选排序
- 延伸节点建议合理性
- 时间窗口下社区对齐
- 质量报告稳定性

---

## 研发 TODO

1. ~~创建并维护 `docs/graphRAG-workflow.md`~~ ✅
2. ~~将 workflow 作为 relation 分支后续模块的总骨架~~ ✅
3. ~~扩展 `types.ts` 定义剪枝与 atom-wise 相关类型~~ ✅，继续补 relation / quality 类型
4. ~~实现社区剪枝模块~~ ✅
5. ~~实现图谱质量评估模块（首版）~~ ✅，继续补质量门控与真实验证
6. 实现潜在关系发掘模块
7. 实现潜在延伸节点发掘模块
8. 实现社区演化追踪模块
9. 为新增模块补测试
10. 在真实研究项目上验证分析质量
11. 更新使用文档与 progress 文档

---

## 建议首个提交

建议从以下提交开始：

```text
feat: add community pruning and graph quality analysis
```

---

## 当前建议

默认建议以“**提升检索质量优先**”作为剪枝目标，而不是单纯去噪或提升可解释性。

原因：

- 当前 GraphRAG 的主要价值仍是检索与上下文组织
- 剪枝首先应该服务检索结果稳定性
- 可解释性和美观结构可以放在第二优先级

此外，workflow 需要作为长期维护对象保留：

- 每完成一个 relation 子能力，都应明确它接入 workflow 的哪一层
- workflow 文档需要持续更新，而不是一次性成稿

---

最后更新: 2026-04-19
