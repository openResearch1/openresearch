# Article Community Similarity 评分细则

## 目标

本文档说明当前论文级 `article_id` 子图 community similarity 的具体评分方法，包括：

- 每篇论文如何切出内部子图
- 每个 community 会提取哪些特征
- 每个分项分数如何计算
- community pair 总分如何聚合
- 两篇论文最终 `similarity` 如何得到

本文档描述的是 **当前实现版本**，对应代码主要位于：

- `packages/opencode/src/tool/atom-graph-prompt/community.ts`
- `packages/opencode/src/tool/atom-graph-prompt/types.ts`

---

## 总流程

当前 `compareArticleCommunities(leftId, rightId, options?)` 的流程如下：

1. 按 `article_id` 分别切出两篇论文的内部 atom 子图
2. 只保留子图内部边，不使用跨论文边
3. 对两篇论文各自运行 Louvain community detection
4. 为每个 community 提取语义、类型、证据、关系、flow、结构、关键词特征
5. 对任意两个 community 计算一个 pair score
6. 对每个方向做 best-match 聚合：
   - `leftToRight`
   - `rightToLeft`
7. 最终：

```ts
similarity = (leftToRight.score + rightToLeft.score) / 2
```

---

## Community 特征提取

对每个 community，当前提取以下特征。

### 1. `emb`

community 的语义中心 embedding。

做法：

1. 读取 community 内每个 atom 的 `claim`
2. 为每个 atom 生成 embedding
3. 对所有 atom embedding 做逐维平均

公式：

```text
emb = mean(atom_embedding_1, atom_embedding_2, ..., atom_embedding_n)
```

### 2. `type`

atom 类型分布，4 个桶：

- `fact`
- `method`
- `theorem`
- `verification`

### 3. `ev`

evidence type 分布，2 个桶：

- `math`
- `experiment`

### 4. `stat`

evidence status 分布，4 个桶：

- `pending`
- `in_progress`
- `proven`
- `disproven`

### 5. `rel`

community 内部 relation type 分布，7 个桶：

- `motivates`
- `formalizes`
- `derives`
- `analyzes`
- `validates`
- `contradicts`
- `other`

### 6. `flow`

community 内部边的 `source_type -> target_type` 分布。

当前一共 16 个桶：

- `fact->fact`
- `fact->method`
- `fact->theorem`
- `fact->verification`
- `method->fact`
- `method->method`
- `method->theorem`
- `method->verification`
- `theorem->fact`
- `theorem->method`
- `theorem->theorem`
- `theorem->verification`
- `verification->fact`
- `verification->method`
- `verification->theorem`
- `verification->verification`

### 7. `share`

community 大小占整篇论文 atom 数的比例：

```text
share = community.size / article_atom_count
```

### 8. `mass`

community 大小占“本篇论文参与比较的 community 总 atom 数”的比例：

```text
mass = community.size / total_compared_community_atoms
```

### 9. `density`

community 内部有向边密度：

```text
density = internal_edges / (n * (n - 1))
```

其中 `n` 是该 community 的 atom 数。

### 10. `hub`

衡量 community 是否被单个 hub 节点主导：

```text
hub = max_degree / total_degree
```

### 11. `keywords`

community 关键词集合。

来源：

- `community.keywords`
- 转小写
- 去空白
- 去重

---

## 分项分数计算

给定两个 community `left` 和 `right`，当前 pair score 由 7 个分项组成。

### 1. `semantic`

community 语义中心向量的余弦相似度：

```ts
semantic = clamp(cosineSimilarity(left.emb, right.emb))
```

即：

```text
semantic = max(0, min(1, cos(left_centroid, right_centroid)))
```

### 2. `type`

两边 atom type 分布的相似度。

当前不是简单 overlap，而是：

```text
type = 1 - JSD(type_left, type_right)
```

实现上通过 `dist(left, right)` 计算：

```text
a = normalize(left)
b = normalize(right)
m = (a + b) / 2
type = 1 - (KL(a || m) + KL(b || m)) / 2
```

最后会被 clamp 到 `[0, 1]`。

### 3. `evidence`

证据分由两部分平均而来：

1. evidence type 分布相似度
2. evidence status 分布相似度

公式：

```ts
evidence = avg([
  dist(left.ev, right.ev),
  dist(left.stat, right.stat),
])
```

也就是：

```text
evidence = mean(1 - JSD(ev_left, ev_right), 1 - JSD(stat_left, stat_right))
```

### 4. `relation`

community 内部 relation type 分布相似度：

```text
relation = 1 - JSD(rel_left, rel_right)
```

### 5. `flow`

community 内部 `source_type -> target_type` 分布相似度：

```text
flow = 1 - JSD(flow_left, flow_right)
```

### 6. `structure`

结构分由 3 个子项平均得到：

1. community 相对大小接近程度
2. density 接近程度
3. hub ratio 接近程度

公式：

```text
size_ratio = min(left.share, right.share) / max(left.share, right.share)
density_similarity = 1 - abs(left.density - right.density)
hub_similarity = 1 - abs(left.hub - right.hub)

structure = mean(size_ratio, density_similarity, hub_similarity)
```

### 7. `keywords`

关键词集合的 Jaccard 相似度：

```text
keywords = |K_left ∩ K_right| / |K_left ∪ K_right|
```

特殊情况：

- 如果两边关键词集合都为空，则直接记为 `1`

---

## 当前权重

当前 community pair 权重如下：

- `semantic`: `0.30`
- `type`: `0.20`
- `evidence`: `0.10`
- `relation`: `0.20`
- `flow`: `0.10`
- `structure`: `0.07`
- `keywords`: `0.03`

总分公式：

```ts
score =
  semantic * 0.30 +
  type * 0.20 +
  evidence * 0.10 +
  relation * 0.20 +
  flow * 0.10 +
  structure * 0.07 +
  keywords * 0.03
```

---

## Directional 聚合

当前不使用 Hungarian matching 作为主评分器。

而是使用 **双向 best-match**：

- `leftToRight`
- `rightToLeft`

### 1. best-match

对于 source 论文中的每个 community：

1. 枚举 target 论文中的所有 community
2. 计算 pair score
3. 取分数最高的那个作为该 community 的最佳匹配

### 2. directional score

一个方向的总分不是简单平均，而是按 source community 的 `mass` 加权：

```text
directional_score = Σ(source_community_mass * best_pair_score)
```

### 3. directional coverage

coverage 也不是“命中了几个 community”，而是：

1. 先检查每个 source community 的 best pair score 是否达到阈值
2. 只有达到阈值的 community 才记入 coverage
3. 用其 `mass` 加权求和

公式：

```text
coverage = Σ(source_community_mass where best_pair_score >= threshold)
```

默认：

```text
coverageThreshold = 0.6
```

在真实测试或实验中，也常用更宽松的：

```text
coverageThreshold = 0.45
```

---

## 最终论文相似度

对两篇论文分别做：

- `leftToRight.score`
- `rightToLeft.score`

最终总分：

```text
similarity = (leftToRight.score + rightToLeft.score) / 2
```

因此当前最终输出包含：

- 总体 `similarity`
- `leftToRight.score`
- `rightToLeft.score`
- 双向 `coverage`
- 每个 community 的最佳匹配明细

---

## 数值截断规则

当前实现中，大部分中间值和输出值都会经过：

```ts
fixed(value) = Number(value.toFixed(4))
```

因此当前评分会保留 4 位小数。

---

## 当前评分行为特征

从当前权重看，较容易把分数拉高的项是：

- `type`
- `relation`
- `flow`
- `evidence`

它们合计权重为：

```text
0.20 + 0.20 + 0.10 + 0.10 = 0.60
```

而更偏“主题区分”的项：

- `semantic`
- `keywords`

合计只有：

```text
0.30 + 0.03 = 0.33
```

这意味着：

- 如果两篇论文在 `method/theorem/verification` 结构上接近
- 在 relation pattern 和 type-flow 形状上也接近

即使主题并不完全一样，也可能得到偏高的 similarity。

这也是后续调权重时最值得继续观察的点。

---

最后更新: 2026-05-06
