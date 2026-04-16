# graphRAG atom-wise 技术方案选择

## 目标

当前 `graphRAG` 已经具备社区级剪枝，但还没有进入 **atom-wise** 层面的精细化控制。

本文档用于给出一套 atom-wise 技术方案选择，明确：

- atom-wise 要解决什么问题
- 可以有哪些技术路线
- 每条路线的优缺点
- 推荐的落地顺序

---

## 为什么需要 atom-wise

当前 pruning 是 **community-wise**：

- 一个社区保留，则社区内全部 atom 都保留
- 一个社区剪掉，则社区内全部 atom 都被排除在检索之外

这会带来两个问题：

1. 保留社区中仍可能存在噪声 atom
2. 被剪社区中可能存在少量关键 atom 被一起丢掉

因此下一步需要引入 atom-wise 机制，回答下面的问题：

- 哪些 atom 虽然在保留社区内，但应该降权或过滤
- 哪些 atom 虽然处于弱社区，但实际上是关键桥接节点
- 哪些 atom 对当前 query 没价值
- 哪些 atom 更适合作为 relation 建议和 extension 建议的起点

---

## atom-wise 的目标分层

atom-wise 方案可以服务 4 类目标：

### 1. 检索净化

减少无关 atom，提高 top-k 质量。

### 2. 图谱质量净化

识别孤立 atom、弱 atom、重复 atom、低价值 atom。

### 3. 关系分析增强

找关键桥接 atom、候选关系核心 atom、延伸点 atom。

### 4. 时间维与演化分析

识别某个时间窗口里重要的 atom、转折点 atom、早期种子 atom。

---

## 方案 A：规则型 atom-wise 剪枝

### 思路

给每个 atom 计算一组局部结构和内容特征，然后用规则做保留/过滤。

### 可用特征

- `degree`
- `inDegree / outDegree`
- `communitySize`
- `communityDensity`
- `isBridgeAtom`
- `claimLength`
- `keywordOverlap`
- `evidenceStatus`
- `atomType`
- `age / recency`

### 规则示例

- 度过低且 claim 太短 -> 降权
- 所属社区质量过低且自身无桥接作用 -> 过滤
- evidence 缺失且无邻居支持 -> 降权
- 属于高 hub 社区但自身不是关键节点 -> 降权

### 优点

- 最容易落地
- 最容易解释
- 和当前 community pruning 一致性最好

### 缺点

- 很难针对具体 query 自适应
- 阈值较多，需要调参

### 适用阶段

适合第一阶段落地。

---

## 方案 B：query-aware atom-wise 重排序

### 思路

不是先“删掉 atom”，而是在检索阶段为 atom 做更细粒度的 query-aware 评分与重排序。

### 评分维度

- query 与 atom 的语义相似度
- atom 与 seed atoms 的距离
- atom 所在社区质量
- atom 是否是桥接节点
- atom 类型是否匹配问题类型
- atom 是否在 answer-bearing chain 上

### 典型形式

```text
atomScore =
  semantic relevance
  + graph proximity
  + bridge bonus
  + community quality bonus
  + type compatibility
  - noise penalty
```

### 优点

- 对最终问答效果更直接
- 比硬剪枝更稳健
- 更适合 LongMemEval 这类任务评估

### 缺点

- 解释性稍弱于纯规则剪枝
- 仍需要确定权重

### 适用阶段

非常适合第二阶段，推荐与当前 GraphRAG 主链路直接结合。

---

## 方案 C：bridge-aware atom 保留

### 思路

把 atom-wise 重点放在“桥接节点”上：

- 社区之间的连接点
- 跨主题的关键中介 atom
- 可能对 relation / extension discovery 很关键的 atom

### 核心指标

- 跨社区连接数
- 邻居社区多样性
- shortest path 中介频率
- 连接高质量社区的能力

### 优点

- 与 relation 分支目标高度一致
- 对潜在关系发掘价值很高

### 缺点

- 不适合作为唯一的 atom-wise 方案
- 只覆盖“结构重要性”，不覆盖“语义重要性”

### 适用阶段

适合作为 query-aware 排序的一个 bonus 项，而不是单独主方案。

---

## 方案 D：atom-wise relation-aware 过滤

### 思路

不是只看 atom 本身，而是看 atom 所处的 relation pattern。

例如：

- `fact -> method -> verification` 链上的 atom 应优先保留
- 与大量 `other` 关系弱连接但缺少高价值关系类型的 atom 应降权
- 缺乏验证链支撑的孤立结论 atom 应降权

### 优点

- 更符合研究图谱语义
- 与潜在关系发掘天然一致

### 缺点

- 需要 relation type 语义足够稳定
- 实现复杂度高于纯规则型

### 适用阶段

适合在 relation-analysis 开始后接入。

---

## 方案 E：temporal-aware atom-wise 过滤

### 思路

引入时间因素，区分：

- 最近新增但尚未验证的 atom
- 早期种子 atom
- 演化中起关键转折作用的 atom

### 使用场景

- temporal thinking
- 社区演化追踪
- 近期研究进展总结

### 优点

- 能回答“最近哪些 atom 更重要”
- 对 evolution analysis 特别有用

### 缺点

- 依赖时间建模质量
- 当前主线还没做完 temporal 最小模型

### 适用阶段

适合作为后续增强，不建议优先实现。

---

## 方案 F：学习型 atom-wise 选择器

### 思路

基于历史问答效果、用户反馈或 benchmark 数据，训练一个 atom-level selector 或 reranker。

### 可能输入特征

- embedding similarity
- graph distance
- community quality
- degree / bridge features
- relation pattern features
- temporal features

### 优点

- 潜在效果上限最高
- 可以真正对齐终局任务表现

### 缺点

- 数据要求高
- 可解释性弱
- 当前阶段工程成本过高

### 适用阶段

不建议近期做，属于长期方案。

---

## 推荐路线

当前最推荐的 atom-wise 路线不是“直接做节点删除”，而是分两步：

### 第一阶段

**规则型 atom 质量打分**

为每个 atom 计算：

- local degree
- bridge bonus
- community quality bonus
- evidence bonus / penalty
- claim length / information density

目标：

- 先形成 `atomScore`
- 不直接删除 atom
- 先用于排序和降权

### 第二阶段

**query-aware atom reranking**

把 `atomScore` 接入 `hybridSearch` 的最终排序阶段，用于：

- top-k 重排序
- token budget 前的精细筛选

### 第三阶段

**relation-aware + temporal-aware 加权**

在 relation-analysis 和 evolution-analysis 落地后，再把：

- relation pattern quality
- temporal importance

接入 atom-wise 评分。

---

## 推荐默认方案

当前建议默认采用：

**保留 A 作为质量特征，生产路径只保留 B 的 reranking 能力**

也就是：

1. 用规则型特征算 atom-level quality score
2. 在检索阶段做 query-aware 重排序
3. 不做 atom-wise 硬过滤

理由：

- 与现有 GraphRAG 主链路兼容最好
- 对 LongMemEval 和真实研究问答都更稳
- 不会像硬过滤那样一刀切丢失潜在关键 atom
- 为后续 relation / quality / temporal 增强保留空间

### ablation 结论

当前已完成 10 样本 LongMemEval ablation：

| 模式          | Before Acc | After Acc |
| ------------- | ---------- | --------- |
| `filter-only` | 65%        | 65%       |
| `rerank-only` | 65%        | 75%       |
| `full`        | 65%        | 75%       |

说明：

- 当前 atom-wise 的收益主要来自 reranking
- 静态 atom 过滤没有带来额外准确率收益

因此当前生产模式选择为：

- `mild` preset
- rerank-only
- 不启用 atom-wise 硬过滤

---

## 建议新增模块

建议后续新增：

- `packages/opencode/src/tool/atom-graph-prompt/atom-quality.ts`
- `packages/opencode/src/tool/atom-graph-prompt/atom-rerank.ts`

建议扩展：

- `packages/opencode/src/tool/atom-graph-prompt/hybrid.ts`
- `packages/opencode/src/tool/atom-graph-prompt/scoring.ts`
- `packages/opencode/src/tool/atom-graph-prompt/types.ts`

---

## 建议指标

第一版 atom-wise 指标建议：

- `degreeScore`
- `bridgeScore`
- `communityScore`
- `evidenceScore`
- `informationScore`
- `queryRelevance`

最终可组合为：

```text
atomScore =
  0.35 * queryRelevance
  + 0.20 * communityScore
  + 0.15 * bridgeScore
  + 0.15 * evidenceScore
  + 0.15 * informationScore
```

这只是建议初值，后续需要实验调参。

---

## 与当前 community pruning 的关系

建议把 atom-wise 视为 community pruning 的下一层：

1. community pruning 先做粗筛
2. atom-wise 再做细排

也就是说：

- community-wise = 粗粒度结构净化
- atom-wise = 细粒度检索优化

两者不是替代关系，而是层级关系。

---

## 当前建议结论

如果只选一条最适合当前阶段的 atom-wise 技术路线，建议选择：

**规则型 atom 质量打分 + query-aware atom 重排序**

这是当前在工程复杂度、可解释性、效果潜力三者之间最平衡的方案。

---

最后更新: 2026-04-16
