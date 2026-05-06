# graphRAG Pruning 技术文档

## 文档目标

本文档说明当前 `graphRAG` 分支中 pruning 的技术方案，包括：

- 当前 pruning 的算法性质
- 社区生成与剪枝判定流程
- 结构指标与评分公式
- 在检索链路中的接入方式
- 当前实验结果
- 已知局限与下一步方向

该文档描述的是 **当前已实现版本**，不是长期理想方案。

---

## 当前 pruning 的技术定位

当前 pruning 不是模型训练得到的剪枝器，也不是对 atom graph 做真实删点删边。

它的本质是：

**基于社区的规则剪枝（post-community rule-based pruning）**

具体来说：

1. 先对 atom graph 做社区检测
2. 为每个社区计算结构指标
3. 用手工阈值规则判断社区保留或移除
4. 在检索阶段只对保留社区做过滤检索

因此当前 pruning 更准确地说是：

- 社区级剪枝
- 规则型剪枝
- 检索时过滤
- 可解释的后处理步骤

而不是：

- 节点级剪枝
- 边级剪枝
- 图数据库真实裁剪
- 学习型剪枝

---

## 相关实现文件

当前 pruning 相关实现位于：

- `packages/opencode/src/tool/atom-graph-prompt/community.ts`
- `packages/opencode/src/tool/atom-graph-prompt/community-prune.ts`
- `packages/opencode/src/tool/atom-graph-prompt/types.ts`
- `packages/opencode/test/tool/atom-graph-prompt/community-prune.test.ts`
- `packages/opencode/test/eval/longmemeval/pruning-eval.ts`

当前默认 pruning 配置由以下常量给出：

- `packages/opencode/src/tool/atom-graph-prompt/community-prune.ts#DEFAULT_PRUNE_OPTIONS`

---

## 总体流程

当前 pruning 的执行流程如下：

1. 从 atom graph 构建有向图
2. 使用 Louvain 算法做社区检测
3. 为每个社区生成基础信息
4. 为每个社区计算 pruning 指标
5. 根据规则判断是否剪枝
6. 返回 `kept / removed / decisions`
7. 在检索阶段，仅在 `kept` 社区中继续 GraphRAG 检索

---

## 第一步：社区生成

当前社区来自 `community.ts` 中的 Louvain 检测：

- `detectCommunities()`
- `louvain(graph, { resolution })`

输出的每个社区包含：

- `id`
- `atomIds`
- `summary`
- `keywords`
- `dominantType`
- `size`
- `density`
- `timestamp`

其中 `density` 的定义是：

```text
density = internalEdges / maxEdges
```

在当前实现中，图被视为有向图，因此：

```text
maxEdges = n * (n - 1)
```

这里的 `n` 是社区中的 atom 数量。

---

## 第二步：pruning 指标计算

在 `community-prune.ts` 中，当前会为每个社区计算以下指标：

### 1. size

社区中的节点数。

### 2. density

社区内部的有向边密度，来自社区检测阶段的现成字段。

### 3. internalEdges

社区内部真实存在的边数。

### 4. maxEdges

社区在当前节点数下理论上可能的最大边数。

### 5. keywordCount

关键词去重后数量：

- 先取 `community.keywords`
- 去空白
- 去重
- 得到 `keywordCount`

### 6. hubRatio

用于衡量社区是否被单个 hub 节点支配。

定义为：

```text
hubRatio = maxDegree / totalDegree
```

其中：

- `maxDegree` = 社区中度数最高节点的度
- `totalDegree` = 社区中所有节点度数之和

如果 `hubRatio` 太高，说明这个社区可能是：

- 星型噪声结构
- 单节点主导结构
- 低解释性但高连接度的伪社区

---

## 第三步：规则型剪枝判定

当前剪枝规则采用 **OR 逻辑**：

只要社区命中任意一条规则，就会被标记为 `pruned`。

当前支持的阈值参数有：

- `minSize`
- `minDensity`
- `minInternalEdges`
- `minKeywords`
- `maxHubRatio`

对应判定条件：

```text
size < minSize
density < minDensity
internalEdges < minInternalEdges
keywordCount < minKeywords
hubRatio > maxHubRatio
```

被剪枝的社区会保留明确原因，例如：

- `size 2 < 4`
- `density 0.018 < 0.03`
- `keywordCount 1 < 2`
- `hubRatio 0.812 > 0.75`

因此当前 pruning 是完全可解释的。

---

## 剪枝结果结构

当前 `pruneCommunities()` 返回：

- `kept`: 保留社区
- `removed`: 被剪掉的社区及原因
- `decisions`: 所有社区的完整决策记录

其中每个决策记录包含：

- `community`
- `pruned`
- `reasons`
- `metrics`

因此当前输出既可用于检索，也可用于调试、评估和后续质量报告。

---

## 当前的社区评分（用于评估）

当前还引入了一个 **community score**，主要用于评估 pruning 前后社区质量变化。

这个分数不是剪枝决策器本身，而是评估指标。

当前公式为：

```text
score =
  0.4 * density +
  0.25 * sizeScore +
  0.15 * keywordScore +
  0.2 * (1 - hubRatio)
```

其中：

```text
sizeScore = min(size / 8, 1)
keywordScore = min(keywordCount / 5, 1)
```

因此该分数偏向：

- 更稠密
- 具有一定规模
- 关键词更丰富
- 不被单个 hub 节点支配

该分数用于 `summarizePruning()` 统计 pruning 前后平均社区质量变化。

---

## 在检索链路中的接入方式

当前 pruning **不会真实删除数据库中的 atom 或 relation**。

它只是得到一组“保留社区 ID”。

然后在 LongMemEval 评估中：

1. 先正常检索一次（before）
2. 再拿 `kept` 社区的 `communityIds`
3. 调 `retrieveContextWithCommunityIds(...)`
4. 让 GraphRAG 只在保留社区中检索（after）

所以当前 pruning 的效果属于：

**retrieval-time filtering**

而不是：

**graph mutation**

这意味着：

- 图结构本身不被永久修改
- pruning 是一个可逆、低风险的实验层
- 适合做前后对照实验

---

## 当前实验结果

当前已经完成 3 组 10 样本 LongMemEval 对照实验：

### 1. 温和阈值

实验配置：

- `minSize=3`
- `minDensity=0.02`
- `minKeywords=2`
- `maxHubRatio=0.8`

结果：

- 平均节点数：`494.5 -> 488.5`
- 平均社区评分：`59.49 -> 60.68`
- 准确率：`65% -> 65%`

### 2. 中等阈值

配置：

- `minSize=4`
- `minDensity=0.03`
- `minKeywords=2`
- `maxHubRatio=0.75`

结果：

- 平均节点数：`494.5 -> 487.9`
- 平均社区评分：`59.49 -> 60.76`
- 准确率：`65% -> 65%`

### 3. 激进阈值（当前默认配置）

配置：

- `minSize=5`
- `minDensity=0.05`
- `minInternalEdges=4`
- `minKeywords=3`
- `maxHubRatio=0.65`

结果：

- 平均节点数：`494.5 -> 465.6`
- 平均社区评分：`59.49 -> 61.11`
- 准确率：`65% -> 65%`

说明：

- 早期一次激进实验曾因 embedding API fallback 污染，得到 `55% -> 55%`
- 在严格模式 `OPENCODE_EMBEDDING_STRICT=1` 下重跑后，确认干净结果应为 `65% -> 65%`

### 当前默认设置

当前默认推荐采用 **激进阈值** 作为 pruning 默认配置：

- `minSize=5`
- `minDensity=0.05`
- `minInternalEdges=4`
- `minKeywords=3`
- `maxHubRatio=0.65`

采用激进阈值的原因：

- 在不降低准确率的前提下，节点压缩效果最好
- 社区评分提升幅度最大
- 结构净化收益最明显
- 作为默认基线更利于后续 relation / quality 能力继续叠加

### 当前结论

当前 pruning 的实验结果说明：

1. pruning 可以稳定减少节点数
2. pruning 可以稳定提升社区结构评分
3. 在严格 embedding API 条件下，激进阈值并未降低准确率
4. pruning 暂时没有带来问答准确率提升

因此当前 pruning 更像是在做：

- 图结构净化
- 社区质量改善

而不是直接做：

- 任务效果最优的检索裁剪

---

## atom-wise ablation 结果

在社区剪枝之外，进一步对 atom-wise 策略做了 10 样本 LongMemEval 对照实验。

目标是回答：

- atom-wise 的效果主要来自静态过滤，还是来自 reranking？

### 实验设置

固定最佳 preset=`mild`，拆为 3 种模式：

1. `full`
   - atom quality 打分 + query-aware reranking
2. `filter-only`
   - 只保留静态 atom 过滤逻辑
3. `rerank-only`
   - 不做 atom 过滤，只做 query-aware reranking

### 结果

| 模式          | Before Nodes | After Nodes | Before Score | After Score | Before Acc | After Acc |
| ------------- | ------------ | ----------- | ------------ | ----------- | ---------- | --------- |
| `full`        | 21.7         | 21.6        | 0.3935       | 0.3942      | 65%        | 75%       |
| `filter-only` | 21.7         | 21.6        | 0.3935       | 0.3942      | 65%        | 65%       |
| `rerank-only` | 21.7         | 21.7        | 0.3935       | 0.3935      | 65%        | 75%       |

### 结论

- 静态 atom 过滤对准确率没有贡献
- query-aware reranking 才是当前 atom-wise 的主要收益来源
- `full` 与 `rerank-only` 的准确率提升一致，说明当前收益几乎全部来自 reranking

### 当前 atom-wise 模式选择

基于上述结果，当前选择：

- **保留 atom-wise reranking**
- **移除 atom-wise 静态过滤**

也就是说：

- atom quality 继续作为排序特征保留
- 但不再用 atom quality 作为生产路径中的硬过滤阈值

这样做的原因：

- reranking 已证明能带来准确率提升
- 静态过滤没有带来额外收益
- 硬过滤存在误删潜在关键 atom 的风险

---

## 技术优点

### 1. 简单

实现成本低，便于快速落地。

### 2. 可解释

每个社区被剪掉都有明确原因。

### 3. 可调参

可以通过阈值快速得到温和、中等、激进不同策略；当前默认采用激进策略。

### 4. 低风险

当前只影响检索过滤，不直接改动图数据。

### 5. 易评估

可以直接做 pruning 前后对照实验。

---

## 当前局限

### 1. 这是社区级剪枝，不是节点级剪枝

一个社区只要保留，里面的噪声节点仍然保留。

### 2. 这是规则型剪枝，不是学习型剪枝

当前阈值不会根据最终任务表现自动学习。

### 3. 不直接对任务目标优化

当前优化目标是：

- 结构质量
- 社区质量

而不是：

- answer-bearing atom 保留率
- top-k 检索命中率
- 问答准确率

### 4. 尚未考虑时间维度

当前 pruning 完全不使用：

- `time_created`
- 主题演化轨迹
- 时间窗口稳定性

### 5. 尚未考虑关系语义强弱

当前 relation type 没有进入 pruning 主判定逻辑。

---

## 为什么当前能提升结构分数，但没提升准确率

因为当前 pruning 主要优化的是：

- 密度
- 规模
- 关键词丰富度
- hub 主导问题

这些属于 **结构质量**。

但 LongMemEval 问答效果更依赖：

- answer-bearing atom 是否被保留
- 检索 top-k 排名是否更准
- 多跳关系是否更接近正确答案

因此当前 pruning 还不是：

**task-aware pruning**

而更像：

**graph hygiene pruning**

---

## 下一步演进方向

下一步可以考虑把当前 pruning 升级为以下方向之一：

### 1. 节点级剪枝

在社区内部进一步识别低价值节点，而不仅仅是社区级别过滤。

### 2. relation-aware 剪枝

把 relation type、桥接边、验证链路纳入剪枝决策。

### 3. task-aware 剪枝

让 pruning 直接为检索命中率和最终问答效果服务。

### 4. temporal-aware 剪枝

考虑社区随时间的稳定性、演化阶段和最近有效性。

### 5. adaptive pruning

根据问题类型自动选择温和、中等或激进阈值，而不是全局固定一组参数。

---

## 一句话总结

当前 pruning 技术是：

**先用 Louvain 做社区检测，再基于 `size / density / internalEdges / keywordCount / hubRatio` 的可解释规则，对社区做后处理过滤，并在检索阶段只保留这些社区。**

它目前更擅长：

- 改善图结构质量
- 降低噪声社区影响

但还不擅长：

- 直接提升最终问答效果

---

最后更新: 2026-04-16
