# 制定调研计划 — Phase 1/4: Plan

分析用户的调研主题，通过 `deep_research_plan` 子 Agent 生成结构化的机器可解析调研计划。然后将计划**精简摘要**呈现给用户确认。

**Phase 1/4 从 plan_task 激活时即已开始。** 此步骤分为 Phase A 和 Phase B，由用户交互分隔。必须先完成 Phase A，暂停等待用户，然后才能进入 Phase B。整个 plan_task 都在 Phase 1/4 范围内。

## Phase A — 生成计划并等待用户确认

1. 从用户的调研主题中提取 2-4 个有意义的英文关键词，用连字符连接作为 `keyword_slug`（例如 `transformer-optimization`）。后续报告文件名将使用 `{keyword_slug}-YYYY-MM-DD.md` 格式。
2. 从对话上下文中提取用户的调研主题、核心需求、范围边界和深度要求。
3. 使用 `task` 工具调用 `deep_research_plan`。**所有三个参数（description, subagent_type, prompt）均为必填项**：
   - `description`：简短描述（例如 "Plan: <research_topic>"）
   - `subagent_type`：`"deep_research_plan"`
   - `prompt`：包含调研主题、范围、深度要求，指定计划必须使用 `## Subtask N: <title>` 格式，子任务总数约 1-2 个（最多 2 个）
   
   示例调用格式：
   ```
   task(description="Plan: <research_topic>", subagent_type="deep_research_plan", prompt="...")
   ```
4. 子 Agent 返回后，**不要将计划写入文件**。仅保存在内存中以备后续步骤使用。
5. 调用 `workflow` 工具，`action` = `"wait_interaction"`，`instance_id` 为当前工作流 ID，`message` 中呈现**精简版**计划摘要。用户看到的是对话消息，必须使用 `\n` 换行（纯文本，不要使用 markdown 代码块）：

   `message` 格式（严格使用 \n 换行，\n\n 分隔段落）：
   `"## Phase 1/4: Plan\n\n🔍 调研主题：<一句话>\n\n子任务（共 N 个）：\n1. <标题> — <一句话目标>\n2. <标题> — <一句话目标>\n...\n\n验证标准：<1-2句话>\n\n回复「确认」开始搜索，或提出修改意见。"`

   注意：不要直接粘贴完整的计划内容。每个子任务用一行描述，不要展开 Search Keywords / Source Types / Verification Focus 等细节。message 中的 \n 必须是真正的换行符，确保用户看到的内容有清晰的段落间距。**message 必须以 `## Phase 1/4: Plan` 开头。**

**⛔ 在此停止！绝对不要调用 `workflow` 工具（action `"next"`）。一旦调用 `next`，当前步骤将变为 `search_verify_task`，该步骤不允许 `wait_interaction`，会导致 "Current step cannot enter waiting_interaction state" 致命错误。必须等待用户回复后才能调用 `next`。**

用户确认后，后续所有阶段（搜索→生成→收尾）将自动推进，不再等待用户交互。

## Phase B — 用户确认后（用户已回复）

6. 如果用户确认计划，调用 `workflow` 工具完成 plan_task 步骤。参数如下：
   - `action`：`"next"`
   - `instance_id`：当前工作流 ID
   - `result`：`{"summary": "用户已确认调研计划，共 N 个子任务。"}`
   - `context_patch`：**必须包含 `plan_complete: true`（布尔值，不是字符串），缺少此字段会导致 NEXT_NOT_ALLOWED 错误。**
     ```
     {
       "research_topic": "<调研主题>",
       "keyword_slug": "<英文关键词>",
       "plan_text": "<子Agent返回的完整计划文本>",
       "plan_complete": true
     }
     ```
   **⚠️ `plan_complete` 必须为布尔值 `true`（不带引号），这是 workflow 引擎检查 `can_next: ["plan_complete"]` 的条件字段。如果缺失或为 falsy，引擎会拒绝 next 操作。**
7. 如果用户要求修改，将反馈重新提交给 `deep_research_plan` 子 Agent，获取修订后的计划，更新 `plan_text`，然后调用 `workflow` 工具（action `"next"`，使用相同的 context_patch（同样必须包含 `plan_complete: true`））。
8. `workflow` 工具（action `"next"`）返回后，search-verify 步骤将变为 active 状态。**立即执行 search-verify 步骤的操作，无需询问用户，无需等待。** 后续所有步骤将自动串行执行到底。

计划必须使用以下机器可解析结构：

```
## Subtask N: <descriptive title>
- **Objective**: <一句话描述此子任务调研的内容>
- **Search Keywords**: <逗号分隔的搜索词列表>
- **Source Types**: <学术论文、行业报告、官方数据、新闻等>
- **Verification Focus**: <需要交叉验证的具体声明或数据点>
- **Priority**: <high | medium | optional>
```

Failure handling:

1. 诊断失败主要属于以下哪一类：
   - `demand_ambiguity` — 补充用户询问并重新运行计划生成
   - `logic_defect` — 触发计划子 Agent 进行二次优化
   - `missing_key_dimension` — 添加缺失维度并重新生成
   - `unknown_issue`
2. 如果多次计划生成失败，请使用 `workflow` 工具（action `"edit"`，`instance_id` 为当前 ID，`ops` 为插入操作数组）在当前步骤后插入 `report_failure`，然后调用 `workflow` 工具（action `"next"`）。

重要规则：

- 不要生成过于宽泛或不可执行的调研计划。
- 计划应包含约 1-2 个子任务（最多 2 个）。
- 每个子任务必须包含具体且可搜索的关键词。
- 确保计划涵盖事实验证、信息收集和总结输出环节。
- 所有调研任务必须拆分为清晰定义的子项目，以便下游并行搜索。
- **不要创建任何文件夹或文件**——计划仅保存在内存中，通过 workflow context 传递。
- 在用户通过 `workflow` 工具（action `"wait_interaction"`）确认计划之前，不要调用 `workflow` 工具（action `"next"`）。
- 向用户展示计划时，务必使用精简摘要格式，不要直接粘贴完整 markdown 计划。
