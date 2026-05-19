# Research Plan — Phase 1/4: Plan

Analyze the user's research topic and generate a structured, machine-parseable research plan via the `deep_research_plan` subagent. Then present a **concise summary** to the user for confirmation.

**Phase 1/4 begins when plan_task activates.** This step is split into Phase A and Phase B, separated by user interaction. You must complete Phase A, pause for user input, then proceed to Phase B. The entire plan_task stays within Phase 1/4.

## Phase A — Generate Plan and Wait for User Confirmation

1. Extract 2-4 meaningful English keywords from the user's research topic, joined by hyphens as the `keyword_slug` (e.g. `transformer-optimization`). The final report filename will use `{keyword_slug}-YYYY-MM-DD.md`.
2. Extract the research topic, core requirements, scope boundaries, and depth expectations from the conversation context.
3. Invoke `deep_research_plan` via the `task` tool. **All three parameters (description, subagent_type, prompt) are required**:
   - `description`: short description (e.g. "Plan: <research_topic>")
   - `subagent_type`: `"deep_research_plan"`
   - `prompt`: include the research topic, scope, depth requirements, the user's **language** (match the user's query language), and specify that the plan must use `## Subtask N: <title>` format, with approximately 2-3 subtasks total

   Example call format:
   ```
   task(description="Plan: <research_topic>", subagent_type="deep_research_plan", prompt="...")
   ```
4. After the subagent returns, **do NOT write the plan to a file**. Keep it in memory for later steps.
5. Call the `workflow` tool with `action` = `"wait_interaction"`, `instance_id` set to the current workflow ID, and present a **concise** plan summary in `message`. The user sees a conversation message; use `\n` for newlines (plain text, no markdown code blocks):

   `message` format (use \n for line breaks, \n\n between paragraphs):
   `"## Phase 1/4: Plan\n\n🔍 Research Topic: <one sentence>\n\nSubtasks (N total):\n1. <title> — <one-sentence goal>\n2. <title> — <one-sentence goal>\n...\n\nVerification Criteria: <1-2 sentences>\n\nReply \"confirm\" to start searching, or suggest modifications."`

   Note: Do NOT paste the full plan. Describe each subtask in one line; omit Search Keywords / Source Types / Verification Focus details. `\n` in the message must be actual newline characters so the user sees clear paragraph spacing. **The message MUST start with `## Phase 1/4: Plan`.**

**⛔ STOP HERE! Do NOT call `workflow` with action `"next"`. Calling `next` transitions the current step to `search_verify_task`, which does not support `wait_interaction`, causing a fatal "Current step cannot enter waiting_interaction state" error. You MUST wait for the user's reply before calling `next`.**

After user confirmation, all subsequent phases (search → generate → finish) proceed automatically without further user interaction.

## Phase B — After User Confirmation (user has replied)

6. If the user confirms the plan, call the `workflow` tool to complete the plan_task step with these parameters:
   - `action`: `"next"`
   - `instance_id`: current workflow ID
   - `result`: a JSON object (NOT a string), e.g. `{"summary": "User confirmed the research plan with N subtasks."}`
   - `context_patch`: a JSON object (NOT a string). **Must include `plan_complete: true` (boolean, not string). Missing this field causes NEXT_NOT_ALLOWED.**

   **CRITICAL — JSON format rules. Violating any of these causes `Error: Invalid input for tool workflow: JSON parsing failed`:**
   - `result` and `context_patch` MUST be passed as native JSON objects — never wrap them in quotes (they are NOT JSON strings).
   - All string values inside `result` and `context_patch` MUST have special characters properly escaped: double quotes `"` → `\"`, backslashes `\` → `\\`, literal newlines in text → `\n`.
   - The plan text can be lengthy. Before embedding it as `plan_text`, strip or escape any unescaped double quotes and backslashes.

   Correct `context_patch` for this step (native JSON object):
   ```
   {
     "research_topic": "<research topic>",
     "keyword_slug": "<English keyword slug>",
     "plan_text": "<full plan text returned by subagent — ensure quotes/backslashes are escaped>",
     "plan_complete": true
   }
   ```
   **⚠️ `plan_complete` must be boolean `true` (no quotes). This is the field checked by the workflow engine's `can_next: ["plan_complete"]` policy. If missing or falsy, the engine rejects the next operation.**
7. If the user requests modifications, resubmit the feedback to the `deep_research_plan` subagent, obtain a revised plan, update `plan_text`, then call `workflow` (action `"next"` with the same context_patch, which must also include `plan_complete: true`).
8. After `workflow` (action `"next"`) returns, the search-verify step becomes active. **Immediately execute the search-verify step instructions — do not ask the user, do not wait.** All subsequent steps run automatically to completion.

The plan must use the following machine-parseable structure:

```
## Subtask N: <descriptive title>
- **Objective**: <one-sentence description of what this subtask investigates>
- **Search Keywords**: <comma-separated search terms>
- **Source Types**: <academic papers, industry reports, official data, news, etc.>
- **Verification Focus**: <specific claims or data points to cross-verify>
- **Priority**: <high | medium | optional>
```

Failure handling:

1. Diagnose which category the failure falls into:
   - `demand_ambiguity` — ask the user for clarification and rerun plan generation
   - `logic_defect` — trigger the plan subagent for a second refinement pass
   - `missing_key_dimension` — add the missing dimension and regenerate
   - `unknown_issue`
2. If plan generation fails repeatedly, use `workflow` (action `"edit"`, `instance_id` set to current ID, `ops` as an array of insert operations) to insert `report_failure` after the current step, then call `workflow` (action `"next"`).

Important rules:

- Do not generate overly broad or unexecutable research plans.
- The plan should contain approximately 2-3 subtasks.
- Each subtask must include concrete, searchable keywords.
- Ensure the plan covers fact verification, information gathering, and synthesis.
- All research tasks must be broken into clearly defined units for downstream parallel search.
- **Do not create any folders or files** — the plan stays in memory only, passed via workflow context.
- Do not call `workflow` (action `"next"`) before the user confirms the plan via `workflow` (action `"wait_interaction"`).
- When presenting the plan to the user, always use the concise summary format — do not paste the full markdown plan.
