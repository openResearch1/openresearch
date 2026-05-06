# Default Deep Research Flow

This flow converts user research demands into standardized, complete research reports through four ordered phases. The primary agent orchestrates all phases and delegates specialized work to subagents.

## Execution Process

### 0. Initialize
- No folder creation — the plan is presented in conversation and kept in-memory
- The only persistent output is the final report file: `{keyword_slug}-YYYY-MM-DD.md`

### 1. Plan Phase (`plan_task`)
- Analyze the user's research topic, scope, and depth requirements
- Invoke `deep_research_plan` subagent via `task` tool to produce a structured research plan (~3-4 subtasks)
- Present the plan to the user and wait for confirmation via `workflow.wait_interaction`
- Pass `plan_text` and `keyword_slug` through workflow context
- Context gate: `plan_complete`
- **After user confirmation, all subsequent phases proceed automatically without further user interaction.**

### 2. Search & Verify Phase (`search_verify_task`)
- Parse `plan_text` from workflow context to extract subtasks (each `## Subtask N:` block)
- Launch parallel `task` calls — one `deep_research_search_verify` subagent per subtask
- Each subagent searches, verifies, and returns ~3 materials in its task response (quality over quantity)
- Consolidate results from all subagent responses, identify information gaps and cross-subtask conflicts
- Pass collected materials to the generate phase via workflow context (`verified_materials`)
- On subtask failures: mark gaps in context or insert `report_failure` via `workflow.edit`
- Context gate: `search_complete`

### 3. Generate Phase (`generate_task`)
- Collect plan from `plan_text` and verified materials from `verified_materials` in workflow context
- Construct report filename: `{keyword_slug}-YYYY-MM-DD.md`
- Invoke `deep_research_generate` subagent via `task` tool to synthesize and write the report
- ALL paper/article titles use 《Title》 format with hyperlinks to source URLs
- No separate References section — sources are cited inline
- Verify report completeness: all chapters present, claims traceable to sources, limitations stated
- Context gate: `report_complete`

### 4. Finish Phase (`finish`)
- Confirm the report file (`{keyword_slug}-YYYY-MM-DD.md`) exists
- Summarize key findings and deliverable path to the user
- Call `workflow.next` to complete the workflow

## Deliverables

Only one file is saved:
- `{keyword_slug}-YYYY-MM-DD.md` — polished final research report (e.g. `transformer-optimization-2026-05-02.md`)

## Error Recovery

When any phase encounters an unrecoverable issue, the agent uses `workflow.edit` to insert the `report_failure` step. This step pauses for user direction via `workflow.wait_interaction` and allows dynamic insertion of recovery steps (re-running a failed phase with adjusted parameters). The workflow engine limits each step kind to 3 occurrences to prevent infinite retry loops.
