# Atom Graph Prompt 使用指南

## 概述

Atom Graph Prompt 提供两个工具：

- `atom_graph_prompt`: 从已知 atom 出发做多跳遍历，适合查看邻域和关系链。
- `atom_graph_prompt_smart`: 在图遍历基础上加入自然语言查询、语义搜索、评分排序和 token 预算控制。

## 何时使用哪个工具

| 场景                               | 推荐工具                  |
| ---------------------------------- | ------------------------- |
| 已知起点 atom，想看附近上下文      | `atom_graph_prompt`       |
| 只有自然语言问题，不知道从哪开始   | `atom_graph_prompt_smart` |
| 既有问题，又想从指定 atom 附近展开 | `atom_graph_prompt_smart` |
| 需要限制输出规模或 token 预算      | `atom_graph_prompt_smart` |
| 需要按社区过滤结果                 | `atom_graph_prompt_smart` |

## 公共枚举值

### `RelationType`

- `motivates`
- `formalizes`
- `derives`
- `analyzes`
- `validates`
- `contradicts`
- `other`

### `AtomType`

- `fact`
- `method`
- `theorem`
- `verification`

## `atom_graph_prompt`

### 参数

| 参数              | 类型                      | 默认值       | 说明                                                             |
| ----------------- | ------------------------- | ------------ | ---------------------------------------------------------------- |
| `atomIds`         | `string[]?`               | 自动推断     | 起始 atom ID 列表。不传时会尝试从当前 session 绑定的 atom 推断。 |
| `maxDepth`        | `number`                  | `2`          | 最大遍历深度。                                                   |
| `maxAtoms`        | `number`                  | `10`         | 最多返回的 atom 数量。                                           |
| `relationTypes`   | `RelationType[]?`         | 全部         | 只遍历指定关系类型。                                             |
| `atomTypes`       | `AtomType[]?`             | 全部         | 只保留指定 atom 类型。                                           |
| `template`        | `"graphrag" \| "compact"` | `"graphrag"` | 输出模板。                                                       |
| `includeEvidence` | `boolean`                 | `true`       | 是否包含 evidence。                                              |
| `includeMetadata` | `boolean`                 | `true`       | 是否包含类型、距离、时间等元数据。                               |

### 示例

```ts
const result = await agent.useTool("atom_graph_prompt", {
  atomIds: ["atom-123"],
  maxDepth: 2,
  maxAtoms: 10,
  template: "graphrag",
})
```

```ts
const result = await agent.useTool("atom_graph_prompt", {
  atomIds: ["atom-456"],
  relationTypes: ["validates", "analyzes"],
  atomTypes: ["theorem", "verification"],
  includeEvidence: false,
  template: "compact",
})
```

### 返回值

```ts
{
  title: "Generated prompt from 5 atom(s)",
  output: "...prompt text...",
  metadata: {
    atomCount: 5,
    seedAtomIds: ["atom-123"],
    maxDepth: 2,
    template: "graphrag",
  },
}
```

## `atom_graph_prompt_smart`

### 参数

| 参数                     | 类型                      | 默认值       | 说明                                       |
| ------------------------ | ------------------------- | ------------ | ------------------------------------------ |
| `query`                  | `string?`                 | -            | 自然语言查询。                             |
| `atomIds`                | `string[]?`               | 自动推断     | 起始 atom ID。与 `query` 可以同时使用。    |
| `maxDepth`               | `number`                  | `2`          | 图遍历深度。                               |
| `maxAtoms`               | `number`                  | `10`         | 最终返回的 atom 数量上限。                 |
| `relationTypes`          | `RelationType[]?`         | 全部         | 只遍历指定关系类型。                       |
| `atomTypes`              | `AtomType[]?`             | 全部         | 只保留指定 atom 类型。                     |
| `semanticTopK`           | `number`                  | `5`          | 语义搜索先召回的 top K。                   |
| `semanticThreshold`      | `number`                  | `0.5`        | 语义相似度阈值。                           |
| `diversityWeight`        | `number`                  | `0.3`        | 多样性权重，越高越偏向类型分散的结果。     |
| `scoringWeights`         | `object?`                 | 默认权重     | 自定义距离、类型、语义、时间、关系链权重。 |
| `communityIds`           | `string[]?`               | -            | 只保留指定社区内的 atoms。                 |
| `minCommunitySize`       | `number?`                 | -            | 只保留社区大小不小于该值的 atoms。         |
| `maxCommunitySize`       | `number?`                 | -            | 只保留社区大小不大于该值的 atoms。         |
| `communityDominantTypes` | `AtomType[]?`             | -            | 只保留主导类型匹配的社区中的 atoms。       |
| `maxTokens`              | `number?`                 | -            | 启用 token 预算控制。                      |
| `template`               | `"graphrag" \| "compact"` | `"graphrag"` | 输出模板。                                 |
| `includeEvidence`        | `boolean`                 | `true`       | 是否包含 evidence。                        |
| `includeMetadata`        | `boolean`                 | `true`       | 是否包含元数据。                           |

### 常见使用方式

#### 1. 纯自然语言查询

```ts
const result = await agent.useTool("atom_graph_prompt_smart", {
  query: "如何提升模型训练稳定性？",
  maxAtoms: 12,
  maxDepth: 2,
})
```

#### 2. 查询和指定起点一起用

```ts
const result = await agent.useTool("atom_graph_prompt_smart", {
  query: "优化算法收敛性",
  atomIds: ["atom-123"],
  maxDepth: 2,
  maxAtoms: 10,
})
```

#### 3. 限制 token 预算

```ts
const result = await agent.useTool("atom_graph_prompt_smart", {
  query: "Transformer 架构的改进方法",
  maxTokens: 3000,
  maxAtoms: 20,
  includeEvidence: false,
})
```

#### 4. 只看某些类型或关系

```ts
const result = await agent.useTool("atom_graph_prompt_smart", {
  query: "理论证明",
  atomTypes: ["theorem", "verification"],
  relationTypes: ["validates", "contradicts"],
  maxDepth: 2,
})
```

#### 5. 按社区过滤

先生成社区缓存：

```ts
import { detectCommunities } from "./tool/atom-graph-prompt/community"

await detectCommunities({
  resolution: 1.0,
  minCommunitySize: 2,
})
```

再在智能工具里过滤：

```ts
const result = await agent.useTool("atom_graph_prompt_smart", {
  query: "深度学习优化方法",
  minCommunitySize: 5,
  communityDominantTypes: ["method", "theorem"],
  maxAtoms: 10,
})
```

### 社区相关 API

如果需要直接查询社区，而不是只在工具里过滤，可以使用：

```ts
import { queryCommunities, getCommunityStats, getAtomCommunity } from "./tool/atom-graph-prompt/community"

const communities = await queryCommunities({
  query: "机器学习优化算法",
  topK: 5,
})

const stats = await getCommunityStats()
const comm = await getAtomCommunity("atom-123")
```

### 返回值

```ts
{
  title: "Generated prompt from 8 atom(s) (semantic search)",
  output: "...prompt text...",
  metadata: {
    atomCount: 8,
    totalFound: 24,
    fromSemanticSearch: 5,
    fromGraphTraversal: 19,
    seedAtomIds: ["atom-123"],
    query: "如何提升模型训练稳定性？",
    maxDepth: 2,
    template: "graphrag",
    estimatedTokens: 2800,
    tokensUsed: 2600,
    budgetUsed: 0.87,
    topScores: [
      { atomId: "atom-1", atomName: "SGD", score: "8.52" },
    ],
  },
}
```

## 模板选择

- `graphrag`: 信息更完整，适合分析、写报告、做推理。
- `compact`: 文本更短，适合 token 预算紧张或只需要快速浏览。

## 最佳实践

1. 已知起点时优先用 `atom_graph_prompt`，不确定起点时再用 `atom_graph_prompt_smart`。
2. `maxDepth` 一般从 `2` 开始，过深容易引入无关信息。
3. 结果太杂时优先加 `atomTypes`、`relationTypes` 或提高 `semanticThreshold`。
4. 结果太长时优先减小 `maxAtoms`，其次切到 `compact` 或关闭 `includeEvidence`。
5. 需要社区过滤时，先运行 `detectCommunities()` 生成缓存。
6. 社区检测和语义搜索默认只作用于当前项目，不会跨项目返回 atoms。

## 故障排查

### 返回 `No atoms found`

- 检查 `atomIds` 是否存在。
- 如果没有传 `atomIds`，确认当前 session 绑定了 atom。
- 放宽 `relationTypes`、`atomTypes` 或社区过滤条件。

### 语义搜索结果不相关

- 改写成更具体的问题。
- 提高 `semanticThreshold`，例如 `0.6` 或 `0.7`。
- 配合 `atomTypes` 或 `atomIds` 缩小范围。

### 输出太长

- 减小 `maxAtoms` 或 `maxDepth`。
- 使用 `compact` 模板。
- 关闭 `includeEvidence` 或设置 `maxTokens`。

### 社区过滤没有结果

- 先确认已经运行过 `detectCommunities()`。
- 检查 `communityIds` 是否存在。
- 放宽 `minCommunitySize`、`maxCommunitySize` 或 `communityDominantTypes`。
