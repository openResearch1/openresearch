# Deep Research Complete — Phase 4/4: Finish

All research phases are complete: **Plan → Search-Verify → Generate → Finish**. Perform finalization tasks and deliver results to the user.

**This phase runs automatically — no user interaction. Do NOT call the `workflow` tool with action `"wait_interaction"`. After calling the `workflow` tool with action `"next"`, the workflow enters the `completed` state.**

## Required actions

1. **Actually verify** that the final report file exists on disk using `bash` or `read`:
   - Run `bash` command: `ls -la "<report_path>"` (using the actual `report_path` value from workflow context)
   - Or use `read` to directly read the report file and confirm its content is complete
   - **Do NOT rely solely on the `report_path` value in workflow context to judge file existence — must actually check on disk.**
2. If the report file does not exist or is incomplete:
   - Report honestly to the user: file not found and possible reasons
   - Record diagnostic information about the missing file
   - Call `workflow` tool: action = `"fail"`, with a clear `code` (e.g. `"REPORT_FILE_MISSING"`) and `message` (explaining to the user why the file was not found). **Both `code` and `message` are required.** Do NOT call `workflow` (action `"next"`)
3. If the report file is confirmed to exist and is complete, clearly present the research results to the user:
   - Research topic and scope
   - Core findings and conclusions (2-4 key points)
   - **Full absolute path** of the report file (use `bash pwd` or similar to obtain)
   - Unresolved research limitations or open questions
4. Call `workflow` tool: action = `"next"`, with `instance_id`, `result`, `context_patch` (including `workflow_finished` = `true`) to complete the workflow.

   **CRITICAL — JSON format rules:**
   - `result` and `context_patch` MUST be native JSON objects — never wrap them in quotes.
   - Escape all double quotes and backslashes in string values.
   - Use forward slashes `/` in file paths, or escape backslashes as `\\`.

   Format:
   ```
   action="next"
   instance_id="<instance_id>"
   result={"summary": "Research topic: ..., core conclusions: ..., report path: ..., limitations: ..."}
   context_patch={"workflow_finished": true}
   ```

## Context writes required before `workflow.next`

- `workflow_finished` — set to `true`

## Result object should summarize

- Research topic
- Core conclusions (brief, 2-4 items)
- Full absolute path of the report file
- Unresolved research limitations

## Important rules

- Do NOT start new analysis, searches, or content generation
- Do NOT modify any deliverable files
- After calling `workflow` (action `"next"`), the workflow enters the `completed` state
- Present a clear final summary to the user before calling `workflow` (action `"next"`)
