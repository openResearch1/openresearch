# LongMemEval 评估计划

> 使用 LongMemEval 基准测试评估 OpenResearch GraphRAG 系统的长期记忆检索能力。

## 背景

### 参考论文

1. **Zep Paper** (arXiv:2501.13956): 提出了基于知识图谱的对话记忆系统，在 LongMemEval 上取得了 SOTA 结果。
2. **LongMemEval** (arXiv:2410.10813, ICLR 2025): 长期对话记忆检索基准，包含 500 个评估实例，覆盖 6 种问题类型。

### 评估目标

验证 OpenResearch 的 GraphRAG 系统（原子知识图谱 + 混合检索）在对话记忆检索任务上的表现，与 Zep 论文中的基线方法进行对比。

---

## 方法论

### 整体流程

```
LongMemEval 数据集
       │
       ▼
┌─────────────────┐
│  数据适配层      │  将对话 sessions 转换为 atom 知识图谱
│  (adapter.ts)   │  每个对话轮次 → fact atom
│                 │  顺序关系 → derives 边
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  检索层          │  对每个问题，使用 graphRAG 混合检索
│  (retrieval.ts) │  语义搜索 + 图遍历 + 智能评分
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  生成层          │  基于检索到的上下文，用 LLM 生成答案
│  (generation.ts)│  OpenAI-compatible API
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  评估层          │  GPT-4o 判断答案正确性（或 substring match）
│  (scorer.ts)    │  按问题类型聚合结果
└────────┬────────┘
         │
         ▼
    评估报告 (report.md)
```

### 数据适配策略

将 LongMemEval 的对话数据映射到我们的原子知识图谱：

| LongMemEval 概念 | OpenResearch 映射 | 说明 |
|-----------------|------------------|------|
| 对话轮次 (turn) | fact atom | 每个 turn 的内容作为 atom claim |
| 会话 (session) | atom 组 + derives 关系 | 同一 session 内的 atoms 通过 derives 连接 |
| 时间戳 | atom.time_created | 保留时间顺序信息 |
| 答案标记 (has_answer) | 用于计算 recall | 不影响图结构 |

支持三种分块策略：
- **turn**: 每个对话轮次一个 atom（最细粒度，默认）
- **session**: 每个会话一个 atom（粗粒度）
- **sliding-window**: 滑动窗口分块（可配置窗口大小）

### 检索策略

使用项目现有的混合检索管线 (`hybridSearch`)：

1. **语义搜索**: 将问题文本向量化，在所有 atoms 中搜索语义相似的内容
2. **图遍历**: 从语义搜索命中的 atoms 出发，BFS 遍历邻居
3. **智能评分**: 综合距离、类型、语义、时间、关系链 5 个维度
4. **MMR 多样性选择**: 平衡相关性和多样性

对比基线：
- `graphrag`: 完整混合检索（默认）
- `semantic-only`: 仅语义搜索，无图遍历
- `full-context`: 全部对话历史作为上下文

### 评估指标

| 指标 | 说明 |
|------|------|
| QA Accuracy | GPT-4o 判断答案正确率（主指标，对标 Zep 论文） |
| Session Recall | 检索结果是否覆盖了答案所在的 session |
| Turn Recall | 检索结果是否包含标记为 has_answer 的 turn |
| Avg Context Tokens | 平均上下文 token 数（效率指标） |
| Avg Latency | 平均检索+生成延迟 |

### 问题类型分类

LongMemEval 包含 6 种问题类型（对标 Zep 论文 Table 3）：

| 类型 | 说明 | 难度 |
|------|------|------|
| single-session-user | 用户在单个 session 中提到的信息 | 低 |
| single-session-assistant | 助手在单个 session 中提供的信息 | 低 |
| single-session-preference | 用户偏好类信息 | 中 |
| temporal-reasoning | 需要时间推理的问题 | 高 |
| knowledge-update | 信息更新后的最新状态 | 高 |
| multi-session | 跨多个 session 的信息整合 | 高 |

---

## 运行指南

### 前置条件

```bash
# 1. 下载数据集
bash packages/opencode/test/eval/longmemeval/download-dataset.sh

# 2. 设置 API Key（LLM 评估模式需要）
export OPENAI_API_KEY=sk-...
```

### 快速测试（无需 API Key）

```bash
# 使用 substring match 评估，10 个问题
bun packages/opencode/test/eval/longmemeval/run-eval.ts \
  --dataset packages/opencode/test/eval/longmemeval/data/longmemeval_s_cleaned.json \
  --max-questions 10 \
  --eval-mode substring
```

### 完整评估

```bash
# GraphRAG 模式，GPT-4o 评估
bun packages/opencode/test/eval/longmemeval/run-eval.ts \
  --dataset packages/opencode/test/eval/longmemeval/data/longmemeval_s_cleaned.json \
  --retrieval-mode graphrag \
  --eval-mode llm \
  --model gpt-4o-mini \
  --top-k 20

# 对比：仅语义搜索
bun packages/opencode/test/eval/longmemeval/run-eval.ts \
  --dataset packages/opencode/test/eval/longmemeval/data/longmemeval_s_cleaned.json \
  --retrieval-mode semantic-only \
  --eval-mode llm

# 对比：全上下文基线
bun packages/opencode/test/eval/longmemeval/run-eval.ts \
  --dataset packages/opencode/test/eval/longmemeval/data/longmemeval_s_cleaned.json \
  --retrieval-mode full-context \
  --eval-mode llm
```

### 运行单元测试

```bash
bun test packages/opencode/test/eval/longmemeval/longmemeval.test.ts
```

### 输出文件

评估完成后在 `output/` 目录生成：

- `predictions.jsonl` — LongMemEval 兼容格式，可直接用官方脚本评估
- `detailed-results.json` — 完整结果含配置和每题详情
- `report.md` — Markdown 报告含对比表格

---

## 预期结果对比

### Zep 论文 Table 2 基线 (LongMemEval_s, ~115k tokens)

| Memory System | Model | Score | Avg Context Tokens |
|--------------|-------|-------|-------------------|
| Full-context | gpt-4o-mini | 55.4% | 115k |
| Full-context | gpt-4o | 60.2% | 115k |
| Zep | gpt-4o-mini | 63.8% | 1.6k |
| Zep | gpt-4o | 71.2% | 1.6k |
| **OpenResearch GraphRAG** | **gpt-4o-mini** | **TBD** | **TBD** |

### 关键差异分析

| 维度 | Zep | OpenResearch GraphRAG |
|------|-----|----------------------|
| 图构建 | LLM 提取实体+事实 | 基于对话轮次的 atom 图 |
| 嵌入 | 真实 embedding API | 简化 TF-IDF 向量化* |
| 检索 | 语义搜索 + 重排 | 混合检索 (语义+图遍历+评分) |
| 社区 | 无 | Louvain 社区检测 |
| 时间推理 | 时间感知的事实管理 | 时间新近度评分 |

*注：当前 embedding 使用简化的哈希向量化，生产环境应替换为真实 embedding API（如 OpenAI text-embedding-3-small）以获得更好的语义检索效果。

---

## 改进方向

1. **Embedding 升级**: 替换 `embedding.ts` 中的简化向量化为真实 embedding API
2. **LLM 实体提取**: 在 adapter 中使用 LLM 提取结构化实体和关系（类似 Zep）
3. **时间推理增强**: 为 temporal-reasoning 类问题添加专门的时间过滤逻辑
4. **知识更新处理**: 对 knowledge-update 类问题，实现事实版本管理
5. **跨 session 关系**: 基于实体共现建立跨 session 的 atom 关系

---

## 文件结构

```
test/eval/longmemeval/
├── types.ts              # 类型定义和配置
├── adapter.ts            # 数据适配：LongMemEval → atom graph
├── retrieval.ts          # 检索管线：graphRAG / semantic / full-context
├── generation.ts         # 答案生成：LLM API 调用
├── scorer.ts             # 评估打分：LLM judge / substring match
├── runner.ts             # 主编排：加载数据 → 评估 → 输出
├── run-eval.ts           # CLI 入口
├── longmemeval.test.ts   # 单元测试
├── download-dataset.sh   # 数据集下载脚本
├── .gitignore            # 忽略 data/ 和 output/
└── eval-plan.md          # 本文档
```
