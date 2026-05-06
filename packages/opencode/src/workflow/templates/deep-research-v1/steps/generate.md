# 生成调研报告 — Phase 3/4: Generate

Integrate all verified materials collected in the search phase and produce the final deep research report via the `deep_research_generate` subagent.

**This phase runs automatically — no user interaction. Do NOT call the `workflow` tool with action `"wait_interaction"`.**

Required actions:

1. Retrieve the plan from workflow context (`plan_text` field) to confirm the report framework and chapter structure.
2. Retrieve all verified materials from the workflow context (`verified_materials` field).
3. 确定报告文件的**完整绝对路径**（此路径将传递给子 Agent 用于 `write` 工具）：
   - 使用 `bash` 执行 `pwd` 获取当前工作目录的绝对路径（例如 `/home/user/project`）
   - 构建完整路径：`<pwd输出>/{keyword_slug}-YYYY-MM-DD.md`（例如 `/home/user/project/transformer-optimization-2026-05-02.md`）
   - 使用 `date` 确定当前日期，格式为 `YYYY-MM-DD`
   - **必须使用完整的绝对路径**——仅使用文件名会导致文件写入错误位置或写入失败
   - 将此完整绝对路径存储为变量，用于步骤 4 的 prompt 和后续 workflow.next 调用
4. Invoke `deep_research_generate` via the `task` tool. **All three parameters (description, subagent_type, prompt) are required**:
   - `description`: short description (e.g. "Generate report: <research_topic>")
   - `subagent_type`: `"deep_research_generate"`
   - `prompt`: MUST include all of the following:
     - The research topic
     - **The EXACT full absolute path from step 3 — tell the subagent: "You MUST call the \`write\` tool with file_path=`<完整绝对路径>` to write the report to disk. Do NOT modify this path."**
     - The plan summary (from `plan_text` context)
     - ALL verified materials (full text from `verified_materials` context)
     - The required report structure (from this step prompt)
     - **Explicit instruction: "Your first action MUST be to call the \`write\` tool. Write the complete report to the specified path BEFORE responding. Do NOT offer to export, save, or adjust. Do NOT ask questions. Call \`write\` immediately."**
   
   Example call format (the prompt text is critical — follow it exactly):
   ```
   task(description="Generate report: <research_topic>", subagent_type="deep_research_generate", prompt="Write the deep research report to disk.\n\nFILE PATH (use exactly as-is): /absolute/path/to/report.md\n\nYOUR ONLY TASK: Call the write tool with this path and the complete report. Do NOT describe the report first. Do NOT ask questions. Do NOT offer options. Call write FIRST, then return a short summary.\n\nResearch Topic: ...\n\nPlan:\n...\n\nVerified Materials:\n...\n\nReport Structure Requirements:\n...")
   ```
5. The subagent writes the final report directly to the constructed absolute path.
6. After the subagent returns:
   - **Use `bash` to verify the report file actually exists on disk**: `ls -la "<完整绝对路径>"`
   - If the file does NOT exist or is empty, the generate phase has FAILED. Call `workflow` tool with action `"fail"`, `code` = `"REPORT_FILE_MISSING"`, and a clear `message`. Do NOT use `edit` — this step does not support it.
   - Verify the file is substantial (not just a few lines — a deep research report should be several KB at minimum)
   - Verify all planned chapters are present
   - Verify key conclusions are supported by the provided materials
   - Verify all paper/article titles use 《Title》 format with hyperlinks to source URLs
   - Verify EACH referenced paper/article has a brief introduction (2-4 sentences) — not just a bare title citation
   - Verify research limitations are explicitly stated
   - Verify the report does NOT include a standalone References section (sources are cited inline)
7. If the report is incomplete or has quality issues, request targeted revision from the subagent before proceeding.
8. **MUST call `workflow` tool**: action = `"next"`, with `instance_id`, `result` object, and `context_patch` object — to advance to the finish phase. **`context_patch` MUST be a JSON object, NOT a string.** Format:
   ```
   workflow(
     action="next",
     instance_id="<instance_id>",
     result={"summary": "Generated report: <research_topic>. Structure: ..., core findings: ..., source count: N, limitations: ..."},
     context_patch={
       "report_title": "<Research Title>",
       "report_path": "/absolute/path/to/report.md",
       "core_conclusions": ["conclusion 1", "conclusion 2", "conclusion 3"],
       "report_complete": true
     }
   )
   ```
   - `result`: summary object with report structure, core findings, source count, and limitations
   - `context_patch` keys: `report_title` (string), `report_path` (full absolute path from step 3), `core_conclusions` (array of 2-4 strings), `report_complete` (boolean `true`)
   - Do NOT manually present the report to the user as the final step — `workflow.next` will transition to the finish step automatically.

The report must follow this structure:

1. **Executive Summary** — overview, key findings, main conclusions (~1 page)
2. **Research Background** — topic context, scope, methodology
3. **Subtask Analysis** — one chapter per subtask with findings, evidence, and analysis. ALL paper/article titles MUST use 《Title》 format with hyperlinks.
4. **Cross-Cutting Analysis** — connections, patterns, and synthesis across subtasks
5. **Conclusions** — systematic answers to the research questions
6. **Risk Warnings & Limitations** — caveats, uncertainty, unresolved issues
(No separate References section — all sources are cited inline with hyperlinked titles)

Context writes required before `workflow.next`:

- `report_title`
- `report_path` (set to the **full absolute path** from step 3, e.g. `"/home/user/project/transformer-optimization-2026-05-02.md"` — NOT just the bare filename)
- `core_conclusions` (2-4 bullet points summarizing the main findings)
- `report_complete` (set to `true`)
Result object should summarize:

- overall structure of the final report
- core research findings and key conclusions
- main reference sources and their count
- any unresolved research limitations

Failure handling:

1. Diagnose whether the failure is primarily a:
   - `material_mismatch` — materials don't align with plan, may need re-organization
   - `logic_disorder` — report structure is incoherent, trigger re-organization
   - `content_incomplete` — missing chapters or sections, request targeted completion
   - `unknown_issue`
2. If materials are insufficient: call `workflow` tool with action `"fail"`, `code` = `"INSUFFICIENT_MATERIALS"`, and a clear `message`. Do NOT use `workflow` tool (action `"edit"`) — this step does not support editing future steps.
3. If the report has structural or logic issues: re-invoke the subagent with specific revision instructions within the same step.
4. If long-form generation fails repeatedly: call `workflow` tool with action `"fail"`, `code` = `"GENERATE_FAILED"`, and a clear `message`.

Important rules:

- **You MUST call `workflow` tool (action `"next"`) after completing all actions.** Do NOT present the report to the user as the final deliverable yet — the workflow state machine advances to the finish step only when the `workflow` tool with action `"next"` is called.
- **After the `workflow` tool (action `"next"`) returns, the finish step becomes active. Immediately execute the finish step instructions without stopping or asking the user.**
- All analysis and conclusions MUST be derived from verified materials — no speculation.
- Every factual claim must be traceable to a source provided in the materials.
- ALL paper, article, and publication titles MUST be wrapped in 《》 and linked to their source URL: `[《Title》](URL)`.

- The report must NOT include a standalone References section — sources are cited inline with hyperlinked 《Title》 links.
- The report language must be formal, concise, and professional.
- Clearly mark unresolved controversial content and research limitations.
- Do NOT fabricate data, sources, or unsubstantiated subjective conclusions.
- Every paper URL must be a direct link to the paper page (arXiv abstract page, open-access publisher page, etc.) — NOT behind paywalls when possible. Prefer arXiv / open-access URLs.
- Only save the report file (`{keyword_slug}-YYYY-MM-DD.md`) — do NOT create any subdirectories or intermediate files.
