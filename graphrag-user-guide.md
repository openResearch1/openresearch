# GraphRAG 用户指南

> 从"手动查找"到"智能检索"—— 用自然语言探索你的研究图谱。

## 什么是 GraphRAG？

在 OpenResearch 中，你的研究被组织为一个 **原子知识图谱** —— 每个 atom 是一个最小的 `声明 + 证据` 单元，atoms 之间通过有类型的关系（motivates, derives, validates 等）连接。

GraphRAG 是一套基于这个图谱的 **智能检索系统**，让你可以：

- **用自然语言搜索**：不需要记住 atom ID，直接问"关于 Transformer 优化的研究有哪些？"
- **自动遍历图谱**：从相关的起点出发，沿着关系链发现更多相关内容
- **智能排序**：综合考虑语义相似度、图距离、类型重要性等多维度评分
- **社区发现**：自动识别你的研究图谱中的主题聚类

与传统的 atom 查询（按 ID 查找或列出全部）不同，GraphRAG 理解 **语义**：即使查询用词和 atom 内容不完全一样，它也能找到概念相关的内容。

---

## 核心概念

### 语义搜索

输入自然语言查询（例如"梯度消失问题的解决方案"），GraphRAG 会：

1. 将查询转换为向量表示
2. 在所有 atom claims 中搜索语义相近的内容
3. 返回按相似度排序的结果

### 混合检索

GraphRAG 结合了两种检索策略：

| 策略         | 工作方式                     | 适用场景             |
| ------------ | ---------------------------- | -------------------- |
| **语义搜索** | 通过文本相似度找到相关 atoms | 开放性问题、主题探索 |
| **图遍历**   | 从起点沿关系链 BFS 扩展      | 已知起点，探索邻域   |

两者可以组合使用：语义搜索找到相关 atoms 作为起点，再通过图遍历发现更多相连的内容。

### 智能评分

每个检索到的 atom 会根据 5 个维度评分：

| 维度       | 权重 | 含义                                   |
| ---------- | ---- | -------------------------------------- |
| 语义相似度 | 30%  | 与查询的语义接近程度                   |
| 图距离     | 25%  | 在图中离起点的跳数，越近越相关         |
| 类型重要性 | 20%  | theorem > method > verification > fact |
| 时间新近度 | 15%  | 最近创建/更新的 atom 得分更高          |
| 关系链质量 | 10%  | 路径上关系类型的重要程度               |

### 社区（Community）

GraphRAG 使用 Louvain 算法自动检测图谱中的 **社区结构**——即紧密关联的 atom 群组。每个社区代表一个研究主题或子领域。

社区信息包括：

- **主导类型**：该社区中最多的 atom 类型（method/theorem/fact/verification）
- **关键词**：社区内 atom 名称构成的关键词列表
- **密度**：内部连接的紧密程度
- **摘要**：自动生成的社区描述

---

## 使用场景

### 场景 1: 文献综述

> "帮我找到项目中所有关于 Transformer 架构改进的研究"

Agent 会使用 GraphRAG 语义搜索，找到与 "Transformer 架构改进" 语义相关的所有 atoms，包括：

- 用不同措辞描述类似内容的 atoms
- 通过关系链连接的相关 theorems 和 verifications
- 自动按相关性排序

### 场景 2: 问题驱动探索

> "梯度消失问题有哪些解决方案？"

Agent 会：

1. 语义搜索找到关于"梯度消失"的 atoms
2. 从这些 atoms 出发，沿 `derives`、`validates` 等关系发现解决方案
3. 综合评分后返回最相关的结果

### 场景 3: 研究脉络追踪

> "这个优化方法是怎么一步步发展来的？"

如果你已经知道某个 atom（或 Agent 通过上下文确定了 atom），GraphRAG 会从该 atom 出发，沿关系链回溯，展示从背景知识（fact）到方法设计（method）到理论分析（theorem）到实验验证（verification）的完整脉络。

### 场景 4: 主题发现

> "我的项目中有哪些主要的研究方向？"

GraphRAG 的社区检测功能会自动识别图谱中的主题聚类，告诉你：

- 有多少个研究主题
- 每个主题包含哪些核心 atoms
- 各主题的主导类型和关键词
- 不同主题之间是否有交叉

### 场景 5: 聚焦式检索

> "只看优化算法这个方向上关于收敛性证明的研究"

结合社区过滤和类型过滤：

- 社区过滤：只在"优化算法"社区中搜索
- 类型过滤：只返回 theorem 类型的 atoms
- 关系过滤：只关注 `validates` 和 `analyzes` 关系

---

## 如何使用

### 日常使用：直接向 Agent 提问

在大多数情况下，你不需要关心底层细节，直接用自然语言向 Research Agent 提问即可：

```
你: 帮我找到关于模型训练稳定性的研究
你: 这个方法的理论基础是什么？
你: 总结一下和正则化相关的所有 atoms
你: 我项目里有哪些研究方向？
```

Research Agent 会自动选择合适的 GraphRAG 工具和参数。

### 高级用法：指定参数

如果你需要更精确的控制，可以在请求中指定参数：

**控制搜索范围**：

```
你: 帮我找关于"注意力机制"的研究，只要 theorem 和 method 类型，最多返回 20 个
```

**控制遍历深度**：

```
你: 从 atom-xxx 出发，看看 3 跳范围内有哪些相关 atoms
```

**使用社区过滤**：

```
你: 在优化算法这个主题下，搜索关于收敛性的内容
```

**控制 token 预算**：

```
你: 给我一份关于"模型压缩"的研究总结，控制在 4000 tokens 以内
```

---

## 两个 GraphRAG 工具

| 工具                      | 适用场景                     | 特点                   |
| ------------------------- | ---------------------------- | ---------------------- |
| `atom_graph_prompt_smart` | 语义搜索、智能检索、社区过滤 | 全功能，推荐日常使用   |
| `atom_graph_prompt`       | 已知 atom ID，简单图遍历     | 轻量快速，Phase 1 兼容 |

通常你不需要手动选择工具 —— Research Agent 会根据你的请求自动判断。

---

## Embedding API 设置

GraphRAG 的语义搜索依赖 embedding。开发环境可以回退到本地 simple embedding，但正式使用和评测时，建议配置真实的 OpenAI-compatible `/embeddings` API。

### 方式 1：环境变量（推荐）

```bash
export OPENCODE_EMBEDDING_MODEL=openai/text-embedding-3-small
export OPENCODE_EMBEDDING_BASE_URL=https://api.openai.com/v1
export OPENCODE_EMBEDDING_API_KEY=your_api_key

# 可选：仅当服务支持自定义维度时设置
export OPENCODE_EMBEDDING_DIMENSIONS=1536
```

说明：

- `OPENCODE_EMBEDDING_MODEL` 格式为 `<provider>/<model>`，例如 `openai/text-embedding-3-small`
- `OPENCODE_EMBEDDING_BASE_URL` 填 OpenAI-compatible 服务根路径，系统会自动请求 `<baseURL>/embeddings`
- `OPENCODE_EMBEDDING_API_KEY` 会作为 `Authorization: Bearer ...` 发送
- `OPENCODE_EMBEDDING_DIMENSIONS` 不是必填项，只有服务支持时才需要设置

### 方式 2：写入 provider 配置

如果你的 LLM 和 embedding 走同一个 provider，也可以直接在 `openresearch.json` 里复用同一套 `baseURL` 和 `apiKey`：

```json
{
  "provider": {
    "openai": {
      "options": {
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "{env:OPENAI_API_KEY}",
        "embeddingModel": "text-embedding-3-small"
      }
    }
  }
}
```

如果 embedding 和对话模型不是同一家服务，也可以单独设置：

```json
{
  "provider": {
    "openai": {
      "options": {
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "{env:OPENAI_API_KEY}",
        "embeddingBaseURL": "https://your-embedding-endpoint.example/v1",
        "embeddingApiKey": "{env:EMBEDDING_API_KEY}",
        "embeddingModel": "text-embedding-3-small"
      }
    }
  }
}
```

### 缓存与回退

- Embedding 缓存在 `atom_list/.atom-embeddings-cache.json`
- 更换 embedding 模型或 API 地址后，旧缓存会自动失效并重建
- 如果远端 embedding API 请求失败，GraphRAG 会回退到本地 simple embedding
- 本地 simple embedding 适合开发调试，不建议用于正式评测

---

## 参数速查

| 参数                | 默认值   | 说明                                 |
| ------------------- | -------- | ------------------------------------ |
| `query`             | -        | 自然语言查询                         |
| `atomIds`           | -        | 指定起始 atom IDs                    |
| `maxDepth`          | 2        | 图遍历最大深度（跳数）               |
| `maxAtoms`          | 10       | 最多返回的 atom 数量                 |
| `atomTypes`         | 全部     | 过滤 atom 类型                       |
| `relationTypes`     | 全部     | 过滤关系类型                         |
| `semanticThreshold` | 0.5      | 语义相似度阈值                       |
| `maxTokens`         | 无限制   | Token 预算限制                       |
| `template`          | graphrag | Prompt 模板（graphrag / compact）    |
| `communityIds`      | -        | 限制在指定社区中搜索                 |
| `diversityWeight`   | 0.3      | 结果多样性（0=纯相关性，1=最大多样） |

---

## 最佳实践

1. **查询要具体**："Transformer 中多头注意力的计算复杂度分析" 优于 "Transformer"
2. **合理设置深度**：`maxDepth=2` 适合大多数场景，`3-4` 用于广泛探索
3. **利用类型过滤**：找理论基础用 `["theorem"]`，找实验证据用 `["verification"]`
4. **利用社区过滤**：先让 Agent 列出社区，再在感兴趣的社区内深入搜索
5. **控制返回数量**：`5-10` 个 atoms 适合聚焦回答，`15-20` 适合全面综述

最后更新: 2026-04-15
