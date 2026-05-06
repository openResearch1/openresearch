# Report Failure and Wait for User Direction

A phase of the deep research workflow encountered an issue that requires user input. Summarize the failure clearly and ask the user how to proceed.

Required actions:

1. Present a clear diagnosis to the user:
   - Which phase failed (planning / search-verification / generation)
   - The specific error or deficiency encountered
   - What was completed successfully before the failure
   - What information or deliverables are still usable
2. Use `workflow` 工具：action = `"wait_interaction"`，附带 `instance_id` 和 `message`，暂停并询问用户：
   - Retry the failed phase (re-run with adjusted parameters)
   - Revise the research plan and re-execute from the relevant phase
   - Skip the problematic subtask and continue with available materials
   - Stop the workflow entirely
3. When the user replies, based on their decision:
   - **Retry**: Use `workflow` tool (action `"edit"`) to insert the appropriate step kind (`plan_task` / `search_verify_task` / `generate_task`) after the current step, then call `workflow` tool (action `"next"`)
   - **Skip**: Call `workflow` tool (action `"next"`) directly with skip-related context
   - **Stop**: Call `workflow` tool: action = `"fail"`，with required `code` (machine-readable, e.g. `"USER_REQUESTED_STOP"`) and `message` (clear user-facing reason). **Both `code` and `message` are required — missing either will cause a validation error.**

Context writes required before `workflow.next`:

- `failure_diagnosis`
- `user_recovery_decision`
- `failure_phase`

Important rules:

- Do NOT automatically retry without explicit user direction.
- Preserve all completed work — do not discard search results or generated content.
- Clearly explain what went wrong so the user can make an informed decision.
- The workflow engine limits each step kind to 3 occurrences — avoid excessive retries.
