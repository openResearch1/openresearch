# Atom Graph Prompt 工具开发进展 (graphRAG / graphRAG-relation 分支)

## 项目概述

本文档记录 graphRAG 基线以及 graphRAG-relation 分支上的增量开发进展。

---

## 开发时间线

### 2026-04-06 - Phase 1 & 2 初始实现 ✅

**提交**: `3329004` - feat: Add Atom Graph Prompt Tool (Phase 1 & 2)

#### Phase 1: 图遍历与基础 Prompt 生成

**实现内容**:

- BFS 图遍历算法
- GraphRAG 和 Compact 两种 prompt 模板
- 关系和类型过滤
- 自动推断起始点

**代码统计**:

- `traversal.ts`: 105 行
- `builder.ts`: 129 行（初始版本）
- `types.ts`: 36 行（初始版本）

#### Phase 2: 智能检索与评分系统

**实现内容**:

- Embedding 缓存系统
- 语义相似度搜索
- 5维度智能评分系统
- 混合检索（图遍历 + 语义搜索）
- 多样性选择算法
- 自适应 Token 预算管理
- `atom_graph_prompt_smart` 工具

**代码统计**:

- `embedding.ts`: 190 行
- `scoring.ts`: 226 行
- `hybrid.ts`: 319 行（初始版本）
- `token-budget.ts`: 268 行
- `atom-graph-prompt-smart.ts`: 新增工具

**文档**:

- 更新 `atom-graph-prompt-usage.md` 添加 Phase 2 使用指南
- 创建 `atom-graph-prompt-phase2-test-design.md` 测试设计文档

---

### 2026-04-08 - Phase 3.1 社区检测 ✅

**提交**: `ea51fac` - feat: Phase 3.1 - Community Detection with Louvain algorithm

**实现内容**:

- Louvain 算法社区检测
- 社区缓存系统（文件缓存，不改动数据库）
- 社区摘要自动生成
- 社区查询（支持自然语言）
- 社区统计信息
- 集成到 `atom_graph_prompt_smart` 工具
- 社区级别 Prompt 生成

**新增文件**:

- `community.ts`: 440 行 - 社区检测核心实现

**修改文件**:

- `types.ts`: +20 行 - 添加 Community 和 CommunityFilterOptions 类型
- `hybrid.ts`: +60 行 - 添加社区过滤支持
- `builder.ts`: +150 行 - 添加 buildCommunityPrompt() 函数
- `atom-graph-prompt-smart.ts`: +20 行 - 添加社区过滤参数

**测试文件**:

- `test/tool/atom-graph-prompt/community.test.ts`: 280 行
  - 6 个测试用例（需要修复数据库依赖）

**依赖安装**:

- `graphology@0.26.0` - 图数据结构库
- `graphology-communities-louvain@2.0.2` - Louvain 社区检测算法

**新增 API**:

```typescript
// 社区检测
detectCommunities(options?: CommunityDetectionOptions): Promise<CommunityCache>

// 社区查询
queryCommunities(options?: CommunityQueryOptions): Promise<Community[]>

// 统计信息
getCommunityStats(): Promise<CommunityStats>

// Atom 社区查询
getAtomCommunity(atomId: string): Promise<Community | null>

// 社区 Atoms 获取
getCommunityAtoms(communityId: string): Promise<string[]>

// 刷新缓存
refreshCommunities(options?: CommunityDetectionOptions): Promise<CommunityCache>

// 社区 Prompt 生成
buildCommunityPrompt(
  communities: Community[],
  atomsByCommunity: Map<string, TraversedAtom[]>,
  options: PromptBuilderOptions
): string
```

**文档更新**:

- 更新 `atom-graph-prompt-usage.md` 添加完整的 Phase 3 章节（+300 行）
  - 核心功能说明
  - API 使用示例
  - 数据结构说明
  - 缓存机制说明
  - 3 个使用场景示例
  - 算法说明
  - 最佳实践
  - 性能考虑

---

### 2026-04-08 - 文档完善 ✅

**提交**: `6184b62` - docs: update plan and add progress tracking

**更新内容**:

- 重构 `atom-graph-prompt-plan.md` 为完整的项目计划
- 创建 `atom-graph-prompt-progress.md` 记录开发进展
- 详细的 Phase 状态和代码统计
- 技术亮点和经验总结

---

### 2026-04-11 - 测试补全 + 文档与 Agent 集成 ✅

**实现内容**:

#### 测试修复与编写

- 修复 `community.test.ts` 的三类数据库依赖问题:
  - `research_project_id` NOT NULL 约束 → 添加 `createResearchProject()` helper
  - `session_id` FK 约束 → 移除无效的 session_id 引用
  - atom_id UNIQUE 约束 → 使用 `crypto.randomUUID()` 生成唯一 ID
- 编写 Phase 2 测试 (42 tests):
  - `embedding.test.ts` (6): 生成/缓存/相似度/持久化/边界/批量
  - `scoring.test.ts` (10): 5 维度单独验证 + 综合排序 + 自定义权重 + MMR + 分数解释
  - `token-budget.test.ts` (13): 4 种文本估算 + 预算选择/优先级/严格预算 + 自适应 + 报告
  - `hybrid.test.ts` (8): BFS 遍历 + 关系/类型过滤 + 语义搜索 + 去重 + token 集成
- 编写 Phase 3 增强测试 (23 tests):
  - `community-advanced.test.ts` (13): 隔离子图分社区/主导类型/密度/摘要/查询/过滤/缓存/边界
  - `builder.test.ts` (9): GraphRAG/Compact prompt + 社区 prompt + evidence/metadata 开关
  - `community-filter.test.ts` (6): communityIds/minSize/maxSize/dominantTypes/语义+社区组合/降级

**总计**: 70 tests, 250 assertions, 0 failures, 1.74s

#### 文档与 Agent 集成

- 创建 `graphrag-user-guide.md`（根目录）: 面向研究人员的用户指南
  - 核心概念（语义搜索/混合检索/智能评分/社区）
  - 5 个使用场景
  - 参数速查表
  - 最佳实践 + FAQ
- 扩展 `research.txt` Agent 系统提示:
  - GraphRAG 工具选择决策表（smart vs basic vs atom_query）
  - 参数指导（query/maxDepth/maxAtoms/filters/budget/template）
  - 5 个使用模式（开放问题/主题探索/邻域/验证链/社区发现）
  - 结果解读和展示指导
  - 错误排查指南
  - Memory Subagent 未来规划占位

#### 计划更新

- 更新 `atom-graph-prompt-plan.md`:
  - 标记测试补全和文档集成为已完成
  - 添加 Phase 5: Memory Subagent 长期计划
  - 更新待完成任务列表
- 更新 `atom-graph-prompt-progress.md`（本文档）

---

### 2026-04-12 - 真实数据测试 + 项目范围修复 ✅

**提交**: `33e8837` - fix: scope community detection and semantic search to current project

#### 发现并修复的 Bug

`buildGraph()`（community.ts）和 `semanticSearch()`（hybrid.ts）加载了全库所有项目的 atoms，未按 `research_project_id` 过滤。当多个研究项目共享同一数据库时，会导致社区检测结果包含跨项目的重复数据。

**修复方案**:

- `community.ts`: 新增 `getResearchProjectId()` 函数，通过 `Instance.project.id` 查询 `ResearchProjectTable` 获取当前项目的 `research_project_id`
- `community.ts`: `buildGraph()` 按 `research_project_id` 过滤 atoms，只加载当前项目的数据
- `hybrid.ts`: `semanticSearch()` 同样按项目过滤 atoms

**修改文件**:

- `community.ts`: +20 行（getResearchProjectId 函数 + 过滤逻辑）
- `hybrid.ts`: +10 行（项目过滤逻辑）

#### 真实数据测试结果

**测试环境**: `research_project_1`（Doc-to-LoRA / Context Distillation 研究）

**数据规模**:
- 13 个 atoms（2 fact, 4 method, 7 verification）
- 36 条关系（4 motivates, 6 derives, 26 validates）

**社区检测结果（resolution=1.0, minCommunitySize=2）**:

| 社区 | 大小 | 主导类型     | 密度  | 主题                                              |
| ---- | ---- | ------------ | ----- | ------------------------------------------------- |
| 0    | 4    | fact         | 0.250 | CD 动机和限制（长上下文推理限制、CD 限制、内存效率） |
| 1    | 4    | verification | 0.250 | Meta-training 目标的实验验证（QA、更新效率、D2L）  |
| 2    | 5    | verification | 0.200 | 架构组件及能力验证（Perceiver、Chunking、检索）     |

**语义查询验证**:
- "context distillation" → Community 0（正确，CD 相关 facts）
- "hypernetwork architecture" → Community 2（正确，架构 methods）
- "retrieval performance" → Community 1（正确，验证结果）

**Resolution 敏感性**:
- 0.5 → 2 社区（粗粒度）
- 1.0 → 3 社区（推荐）
- 1.5 → 4 社区
- 2.0 → 4 社区（细粒度）

**结论**: 社区检测在真实数据上产生了语义合理的分组，查询排序符合预期。

---

### 2026-04-19 - graphRAG-relation 状态核对 ✅

#### Embedding API

- `embedding.ts` 继续保留了真实 embedding API 接入，不再只是简单的本地 mock 向量
- 当前仍使用 OpenAI-compatible `/embeddings` 接口，并支持从 `provider.options` 或环境变量解析：
  - `OPENCODE_EMBEDDING_MODEL`
  - `OPENCODE_EMBEDDING_BASE_URL`
  - `OPENCODE_EMBEDDING_API_KEY`
  - `OPENCODE_EMBEDDING_DIMENSIONS`
- 相比父分支 `graphRAG`，本分支额外增加了：
  - `OPENCODE_EMBEDDING_STRICT`：严格模式下远程 embedding 失败直接报错，不回退 simple embedding
  - `OPENCODE_EMBEDDING_RETRIES`：对 408/409/425/429/5xx 做重试与退避
- 仍保留 384 维 simple embedding 作为 fallback 路径，缓存版本已升级到 `2.0`

#### Pruning / atom-wise

- 新增 `community-prune.ts`，已实现社区级规则剪枝：`size / density / internalEdges / keywordCount / hubRatio`
- 当前默认 pruning 基线已落在 `DEFAULT_PRUNE_OPTIONS`
- 新增 `atom-quality.ts` 与 `atom-rerank.ts`
- 新增 `graph-quality.ts`，提供首版 graph assessment / quality report API
- `hybrid.ts` 已接入 atom-wise quality scoring + query-aware reranking
- 当前状态需要区分：
  - 社区 pruning 模块、测试和 LongMemEval 评估脚本已落地
  - 但 pruning 还没有默认接入主检索 workflow，当前主要用于评估与手动过滤
  - graph assessment 已有独立模块，但还没有默认接入 workflow 质量门控

#### 本次核对验证

- `bun test test/tool/atom-graph-prompt/community-prune.test.ts` 通过（4 tests）
- `bun test --timeout 30000 test/tool/atom-graph-prompt/atom-wise.test.ts` 通过（4 tests）
- `bun test --timeout 30000 test/tool/atom-graph-prompt/graph-quality.test.ts` 通过（2 tests）
- `embedding.test.ts` 仍有旧版断言与超时假设，测试尚未完全跟上当前 embedding v2 实现

---

### 2026-04-22 - 论文级 Community Similarity ✅

#### 实现内容

- 在 `community.ts` 中新增 `compareArticleCommunities(leftId, rightId, options?)`
- 社区检测补充 article-scoped 子图模式：
  - 用 `AtomTable.article_id` 切论文内部 atoms
  - 只保留论文内部边
  - 不污染现有项目级 community cache
- 为每个社区提取以下比较特征：
  - 语义 centroid embedding
  - atom type 分布
  - evidence type / status 分布
  - relation type 分布
  - `source_type -> target_type` flow 分布
  - size / density / hub ratio 结构特征
  - keywords
- 聚合方式采用双向 best-match：
  - `leftToRight`
  - `rightToLeft`
  - 对称 `similarity = (ltr + rtl) / 2`
  - 双向 `coverage`

#### 测试

- 新增 `community-similarity.test.ts`
- 覆盖 3 类场景：
  - 相似论文得分高于不相关论文
  - split / merge community 下仍能稳定比较
  - 空论文边界返回 0 similarity

#### 文档同步

- 更新 `docs/graphRAG-relation-plan.md`
- 更新 `docs/graphRAG-workflow.md`
- 更新 `docs/atom-graph-prompt-progress.md`

---

### 2026-05-06 - 真实项目 Similarity 验证 + 评分文档 ✅

#### 真实项目验证

- 已在两个真实项目上完成真实数据 similarity 测试：
  - `~/research_project_1`
  - `~/research_project_2`
- 在真实测试中发现：
  - 部分项目历史上将“论文目录”作为单个 `article` 导入
  - 导致多个来源论文共用同一个 `article_id`
  - 需要先修正 `article_id`，才能可靠地执行 paper similarity

#### Project 1

- 修复后得到 3 篇真实论文子图：
  - `AutoSchemaKG`
  - `Text-to-LoRA`
  - `Doc-to-LoRA`
- pairwise similarity：
  - `AutoSchemaKG` vs `Text-to-LoRA` = `0.7661`
  - `AutoSchemaKG` vs `Doc-to-LoRA` = `0.7726`
  - `Text-to-LoRA` vs `Doc-to-LoRA` = `0.7580`

#### Project 2

- 修复后得到 4 篇真实论文子图：
  - `Doc-to-LoRA`
  - `Long-Document QA / CoST / LITECOST`
  - `SHINE`
  - `MemoryBank`
- 最高分 pair：
  - `Doc-to-LoRA` vs `Long-Document QA / CoST` = `0.8514`

#### Embedding / quality 验证

- strict probe 再次确认远端 embedding API 可连通：
  - `openai/text-embedding-3-small@https://api.openai.com/v1`
  - `1536` 维
- `graph-quality.test.ts` 在真实 embedding 路径下通过：
  - `OPENCODE_EMBEDDING_STRICT=1`
  - `OPENCODE_EMBEDDING_RETRIES=0`
  - `bun test --timeout 120000 test/tool/atom-graph-prompt/graph-quality.test.ts`

#### 文档

- 新增评分细则文档：
  - `docs/article-community-similarity-scoring.md`

#### 当前结论

- paper similarity 已能稳定跑通真实项目
- 但当前权重更偏结构相似，主题区分度仍然有限

---

## graphRAG 基线状态快照 + graphRAG-relation 增量

### 代码库统计

**总代码量**: ~1,960 行（graphRAG 基线的 atom-graph-prompt 模块）

**文件结构**:

```
packages/opencode/src/tool/atom-graph-prompt/
├── builder.ts        (265 行) - Prompt 构建 + 社区 Prompt
├── community.ts      (460 行) - 社区检测 + 项目范围过滤
├── embedding.ts      (190 行) - Embedding 管理
├── hybrid.ts         (375 行) - 混合检索 + 社区过滤 + 项目范围语义搜索
├── scoring.ts        (226 行) - 智能评分
├── token-budget.ts   (268 行) - Token 预算
├── traversal.ts      (105 行) - 图遍历
└── types.ts          (55 行)  - 类型定义 + 社区类型
```

**测试文件**（graphRAG 基线时 70 个测试全部通过）:

```
packages/opencode/test/tool/atom-graph-prompt/
├── community.test.ts          (339 行) -  5 tests - 社区检测基础
├── community-advanced.test.ts (342 行) - 13 tests - 社区检测增强
├── community-filter.test.ts   (384 行) -  6 tests - 社区过滤集成
├── embedding.test.ts          (168 行) -  6 tests - Embedding 系统
├── scoring.test.ts            (232 行) - 10 tests - 评分系统
├── token-budget.test.ts       (233 行) - 13 tests - Token 预算
├── hybrid.test.ts             (413 行) -  8 tests - 混合检索 + 图遍历
└── builder.test.ts            (318 行) -  9 tests - Prompt 构建
```

**文档**:

- `graphrag-user-guide.md` - 用户指南（根目录）
- `docs/atom-graph-prompt-usage.md` - 技术使用指南（~800 行）
- `docs/atom-graph-prompt-plan.md` - 开发计划
- `docs/atom-graph-prompt-phase2-test-design.md` - Phase 2 测试设计
- `docs/atom-graph-prompt-progress.md` - 本文档
- `docs/article-community-similarity-scoring.md` - 论文级 similarity 评分细则
- `packages/opencode/src/agent/prompt/research.txt` - Agent GraphRAG 指导

### 功能完成度

| Phase                    | 状态    | 完成度 | 分支     |
| ------------------------ | ------- | ------ | -------- |
| Phase 1: 图遍历          | ✅ 完成 | 100%   | graphRAG |
| Phase 2: 智能检索        | ✅ 完成 | 100%   | graphRAG |
| Phase 3.1: 社区检测      | ✅ 完成 | 100%   | graphRAG |
| Phase 3.1 测试补全       | ✅ 完成 | 100%   | graphRAG |
| 文档与 Agent 集成        | ✅ 完成 | 100%   | graphRAG |
| 真实数据测试 + Bug 修复  | ✅ 完成 | 100%   | graphRAG |
| Phase 3.2: 社区分析增强  | 🟡 进行中 | 40%  | graphRAG-relation |
| Atom-wise reranking      | ✅ 完成 | 100%   | graphRAG-relation |
| Phase 4: 高级功能        | 🔲 长期 | 0%     | -        |
| Phase 5: Memory Subagent | 🔲 长期 | 0%     | -        |

---

## 技术实现亮点

### 1. 社区检测 (Phase 3.1)

**Louvain 算法**:

- 模块度优化的社区检测算法
- 支持分辨率参数调整社区粒度
- 高效处理大规模图

**社区密度计算**:

```typescript
density = 内部边数 / 最大可能边数
```

**主导类型识别**:

- 统计社区内各 atom 类型数量
- 选择数量最多的类型作为主导类型

**自动摘要生成**:

- 提取 atom 名称作为关键词
- 统计类型分布
- 生成简洁的文本摘要

### 2. 缓存策略

**Embedding 缓存**:

- 位置: `atom_list/.atom-embeddings-cache.json`
- 避免重复计算 embedding
- 版本控制支持

**社区缓存**:

- 位置: `atom_list/.atom-communities-cache.json`
- 文件缓存，不改动数据库
- 首次检测后即时响应
- 支持手动刷新

### 3. 工具集成

**社区过滤参数**:

```typescript
{
  communityIds?: string[]           // 指定社区 ID
  minCommunitySize?: number         // 最小社区大小
  maxCommunitySize?: number         // 最大社区大小
  communityDominantTypes?: AtomType[] // 主导类型过滤
}
```

**使用示例**:

```typescript
// 在智能工具中使用社区过滤
await agent.useTool("atom_graph_prompt_smart", {
  query: "模型优化方法",
  communityIds: ["community-1", "community-3"],
  maxAtoms: 10,
})
```

---

## 待完成任务

### 已完成 ✅

1. ~~修复 community.test.ts 的数据库依赖问题~~ ✅
2. ~~实现 Phase 2 测试用例~~ ✅ (70 tests)
3. ~~创建用户指南文档~~ ✅
4. ~~扩展 agent 系统提示~~ ✅
5. ~~在真实 Atom Graph 上测试社区检测~~ ✅ (13 atoms, 3 社区, 语义查询验证通过)
6. ~~修复项目范围 bug~~ ✅ (community.ts, hybrid.ts 按 research_project_id 过滤)

### 中优先级

7. **功能增强**
   - 补齐 `embedding.test.ts` 到当前 `CACHE_VERSION=2.0` 与远程 embedding 行为
   - 评估是否将 community pruning 默认接入主检索 workflow
   - 性能测试和优化

### 长期

7. Phase 3.2: 社区分析增强
8. Phase 4: 高级功能（时序/推荐/可视化）
9. Phase 5: Memory Subagent

---

## 经验总结

### 成功经验

1. **模块化设计**: 每个功能独立模块，易于测试和维护
2. **文件缓存**: 避免数据库改动，降低复杂度
3. **类型安全**: 完整的 TypeScript 类型定义
4. **文档先行**: 详细的使用文档和 API 说明
5. **向后兼容**: Phase 1 功能完全兼容

### 遇到的挑战

1. **测试数据库依赖**: 需要完整的 research project 设置
   - `research_project_id` 是 NOT NULL 字段
   - 需要先创建 ResearchProject 才能创建 Atom

2. **Embedding 测试与当前实现不同步**
   - 当前代码已支持真实 embedding API + fallback/strict/retry
   - `embedding.test.ts` 仍以旧版缓存版本和 5 秒默认超时为前提

3. **社区质量**: ✅ 已在实际数据上验证
   - 社区大小合理（4-5 个 atoms/社区，resolution=1.0）
   - 摘要准确，能反映社区主题
   - 关键词有代表性，语义查询排序符合预期

4. **项目范围隔离**: buildGraph() 和 semanticSearch() 未按项目过滤
   - 多项目共享数据库时会加载全部 atoms
   - 已修复：通过 Instance.project.id → ResearchProjectTable → research_project_id 过滤

### 改进方向

1. **性能基准**: 建立性能基准测试
2. **用户反馈**: 在实际使用中收集反馈
3. **Embedding 测试**: 补齐远程 API、strict mode、重试和空文本行为测试

---

## 下一步计划

### 短期（1-2 周）

1. 同步 embedding 测试与文档到当前 v2 实现
2. 评估 community pruning 的默认接入点
3. 收集用户反馈和改进建议

### 中期（1 个月）

1. 性能测试和优化
2. Phase 3.2: 社区间关系分析

### 长期（3 个月）

1. Phase 4: 高级功能（时序/推荐/可视化）
2. Phase 5: Memory Subagent

---

## 提交历史

| 提交      | 日期       | 说明                             |
| --------- | ---------- | -------------------------------- |
| `3329004` | 2026-04-06 | Phase 1 & 2 初始实现                    |
| `ea51fac` | 2026-04-08 | Phase 3.1 社区检测                      |
| `6184b62` | 2026-04-08 | 文档更新和进展记录                      |
| `2a5ae23` | 2026-04-11 | 测试补全 + 用户指南 + Agent 集成        |
| `33e8837` | 2026-04-12 | 项目范围修复 + 真实数据测试验证         |

---

## 贡献者

- **开发**: zj45
- **分支**: graphRAG -> graphRAG-relation
- **时间**: 2026-04-06 至今
- **代码量**: ~5,100+ 行（含测试和文档）

---

最后更新: 2026-05-06
