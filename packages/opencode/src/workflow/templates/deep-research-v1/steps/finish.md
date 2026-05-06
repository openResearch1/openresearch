# 深度调研完成 — Phase 4/4: Finish

所有调研阶段已完成：**Plan → Search-Verify → Generate → Finish**。执行收尾工作并向用户交付成果。

**This phase runs automatically — no user interaction. Do NOT call the `workflow` tool with action `"wait_interaction"`. After calling the `workflow` tool with action `"next"`, the workflow enters the `completed` state.**

## Required actions

1. 使用 `bash` 或 `read` 工具**实际验证**最终报告文件确实存在于磁盘上：
   - 执行 `bash` 命令：`ls -la "<report_path>"`（使用 workflow context 中 `report_path` 的实际值）
   - 或者使用 `read` 工具直接读取报告文件，确认其内容完整
   - **不要仅依赖 workflow context 中的 `report_path` 值来判断文件是否存在——必须在磁盘上实际检查。**
2. 如果报告文件不存在或不完整：
   - 向用户如实报告：文件未找到及可能原因
   - 记录缺失的诊断信息
   - 调用 `workflow` 工具：action = `"fail"`，附上明确的 `code`（如 `"REPORT_FILE_MISSING"`）和 `message`（向用户说明文件未找到的原因），**`code` 和 `message` 均为必填项**。不要调用 `workflow` 工具（action `"next"`）
3. 如果报告文件确认存在且完整，向用户清晰汇报调研成果：
   - 调研主题和范围
   - 核心发现和结论（2-4 条要点）
   - 报告文件的**完整绝对路径**（使用 `bash pwd` 或类似方法获取）
   - 未解决的研究局限或待探索问题
4. 调用 `workflow` 工具：action = `"next"`，附带 `instance_id`、`result`、`context_patch`（含 `workflow_finished` = `true`）完成流程。

## Context writes required before `workflow.next`

- `workflow_finished` — 设置为 `true`

## Result object should summarize

- 调研主题
- 核心结论（简要，2-4 条）
- 报告文件的完整绝对路径
- 未解决的研究局限

## Important rules

- 不要再启动新的分析、搜索或内容生成
- 不要再修改任何交付物文件
- 调用 `workflow` 工具（action `"next"`）后，工作流将进入 `completed` 状态
- 在调用 `workflow` 工具（action `"next"`）之前向用户展示清晰的最终报告
