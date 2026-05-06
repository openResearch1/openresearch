# GraphRAG Workflow

## 目标

本文档定义本项目当前建议采用的 GraphRAG 完整工作流，从研究输入开始，到图谱更新结束，形成一个可反复迭代的闭环。

该 workflow 强调三点：

1. 研究状态优先，而不是一次性回答优先
2. 图谱是核心中间层，而不是附属索引
3. 每个阶段都需要区分已实现能力与待实现能力

---

## 总览

完整流程如下：

1. 研究初始化
2. 原子化建图
3. GraphRAG 预处理层
4. 用户查询进入
5. GraphRAG 检索执行
6. 生成研究回答/总结
7. 结果回写与图谱演化
8. 高阶分析与下一步建议

这 8 个阶段构成一个从起始到结束的完整闭环。

---

## 1. 研究初始化

### 输入

- 用户研究目标
- 项目目录
- 背景文档
- 研究问题
- 已有论文或笔记

### 处理

- 建立 research project
- 准备 background / goal / macro 信息
- 确认当前项目上下文

### 已实现

- 项目与 research project 体系
- research 路由与相关工具
- Research Agent 已具备 GraphRAG 使用指导

### 未实现

- GraphRAG 初始化向导
- 根据研究目标自动建议初始图谱结构

---

## 2. 原子化建图

### 输入

- 论文
- 实验结论
- 用户研究笔记
- 讨论记录

### 处理

- 将内容拆解为 atom
- 写入 claim / evidence
- 建立 typed relation
- 形成 atom graph

### 已实现

- atom CRUD
- atom relation CRUD
- atom graph 基础数据模型
- Agent 中对 atom / relation 语义已有约束

### 未实现

- 更系统的批量原子化流水线
- 自动关系补全推荐
- 图谱健康检查

---

## 3. GraphRAG 预处理层

### 输入

- 当前项目 atom graph

### 处理

- embedding 缓存
- 语义搜索准备
- 社区检测
- 社区缓存
- 项目范围隔离

### 已实现

- embedding 缓存、真实 API 接入与回退
- hybrid semantic search
- Louvain 社区检测
- 社区摘要、关键词、主导类型、密度
- 社区缓存
- 社区剪枝模块（规则型，可独立执行）
- 图谱质量评估模块（可独立执行）
- 项目范围隔离

### 未实现

- 增量更新机制
- 社区剪枝默认接入主检索前置门控
- 社区演化追踪
- 图谱质量评估默认接入检索前质量门控
- 潜在关系发掘
- 潜在延伸节点发掘

---

## 4. 用户查询进入

### 输入

- 自然语言问题
- 指定 atom ID
- 指定主题
- 指定社区范围

### 处理

- Agent 选择合适工具：
  - `atom_graph_prompt_smart`
  - `atom_graph_prompt`
  - `atom_query`

### 已实现

- GraphRAG 工具选择规则
- smart/basic 两套 GraphRAG 工具
- community filter 参数接入

### 未实现

- 问题类型到参数模板的自动映射
- temporal query 模式
- relation-analysis 模式

---

## 5. GraphRAG 检索执行

### 处理链

1. 语义搜索找起点
2. 图遍历扩展邻域
3. 社区过滤
4. 多维评分
5. 多样性选择
6. token budget 裁剪
7. 生成结构化上下文

### 已实现

- semantic + traversal 混合检索
- 5 维评分
- atom-wise quality scoring + query-aware reranking
- 多样性选择
- token budget
- 社区过滤

### 未实现

- 剪枝后的检索路径优化
- relation-aware reranking
- extension-aware retrieval
- temporal-aware retrieval

---

## 6. 生成研究回答/总结

### 输入

- 检索出的 atoms
- GraphRAG 结构化上下文

### 处理

- 回答用户问题
- 生成综述
- 生成理论链路或验证链路摘要
- 输出主题总结

### 已实现

- GraphRAG prompt 生成
- `graphrag` / `compact` 模板
- Agent 已能基于 GraphRAG 输出研究回答

### 未实现

- 社区级回答模板
- 演化轨迹回答模板
- 潜在关系建议模板

---

## 7. 结果回写与图谱演化

### 输入

- 用户确认
- 新实验结果
- 新论文
- 新假设
- 回答中发现的新 claim

### 处理

- 写入新 atom
- 写入新 relation
- 刷新图谱状态
- 进入下一轮检索与分析

### 已实现

- atom / relation 可继续写入
- 图谱可持续被查询
- 系统已有 `research.atoms.updated` 事件链

### 未实现

- GraphRAG 输出后的自动回写流程
- 基于更新事件的 embedding / community 增量刷新
- 社区或主题级演化时间线

---

## 8. 高阶分析与下一步建议

### 目标

不只回答“已有内容”，还要回答：

- 哪些社区值得保留
- 两篇论文的 community similarity 是否接近
- 哪些关系可能缺失
- 哪些主题在演化
- 哪些方向值得延伸
- 当前图谱是否健康

### 已实现

- 基础社区检测
- 社区查询
- 社区过滤
- 论文级子图 community similarity 比较（内部边、对称 similarity、双向 coverage）
- 两个真实研究项目上的 paper similarity 实跑验证

### 未实现

- 社区剪枝
- 社区演化追踪
- 潜在关系发掘
- 潜在延伸节点发掘
- 图谱质量评估指标

---

## 当前已跑通的闭环

当前系统已经稳定具备以下闭环：

1. 项目存在
2. atom / relation 已存在
3. embedding 可生成
4. community 可检测
5. 用户自然语言提问
6. smart GraphRAG 检索
7. 返回结构化上下文与回答

也就是说，当前已经完成了：

- 从问题到图谱检索再到回答的主链路

但还没有完全完成：

- 从研究演化角度持续维护图谱的增强闭环

---

## 下一阶段接入点

建议按以下顺序增强 workflow：

1. 社区剪枝
2. 图谱质量评估
3. 潜在关系发掘
4. 潜在延伸节点发掘
5. 社区演化追踪

### 接入建议

- 社区剪枝：接在第 3 步预处理层
- 图谱质量评估：接在第 3 步之后，作为检索前质量门控
- 潜在关系发掘：接在第 8 步，作为建议回写入口
- 潜在延伸节点发掘：接在第 8 步，作为研究建议入口
- 社区演化追踪：横跨第 7-8 步，形成时间维闭环

---

## 三层结构建议

为了后续研发清晰，建议将整个 GraphRAG workflow 拆成三层：

### 1. 基础检索层

- atom graph
- hybrid retrieval
- prompt building

### 2. 结构分析层

- community
- prune
- quality
- paper similarity
- relation candidates
- extension candidates

### 3. 研究演化层

- temporal thinking
- evolution tracking
- graph update loop

---

## 当前结论

当前 `graphRAG` 已完成“从问题到图谱检索再到回答”的工作流主链路。

下一阶段研发重点不应再放在底层存储切换，而应放在：

- 结构分析层
- 关系增强层
- 研究演化层

这也是 `graphRAG-relation` 分支的主要任务来源。

---

最后更新: 2026-05-06
