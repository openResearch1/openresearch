# 搜索与事实核查 — Phase 2/4: Search-Verify

Execute multi-source information retrieval and cross factual verification by dispatching parallel `deep_research_search_verify` subagents — one per subtask from the research plan. Results are collected in-memory and passed to the generate phase via workflow context.

**This phase runs automatically after plan confirmation — no user interaction. Do NOT call the `workflow` tool with action `"wait_interaction"`.**

**Subagent boundary: You are in Phase 2/4 (Search-Verify). ONLY call `subagent_type="deep_research_search_verify"`. Do NOT call `deep_research_generate` (reserved for Phase 3/4) or `deep_research_plan` (reserved for Phase 1/4). Generating the report here would skip a required workflow step.**

Required actions:

1. Retrieve the research plan from workflow context (`plan_text` field). Parse all subtasks from the structured format (each `## Subtask N: <title>` block).
2. For each subtask, prepare a focused task prompt that includes:
   - The subtask objective and search keywords
   - The specified source types and verification focus
   - Instruction to return results directly in the task response (NOT write to files)
   - Required output format: search queries used, sources found, verification assessment per source, valid materials (target ~2 per subtask), rejected materials (with reasons), conflicts noted
3. Launch ALL tasks in a **single message as parallel calls**. Each call MUST include all three required parameters (`description`, `subagent_type`, `prompt`):
   ```
   task(description="Search: <subtask title>", subagent_type="deep_research_search_verify", prompt="<focused prompt>")
   ```
   One call per subtask.
4. After all subagents return, collect and consolidate their responses:
   - Count total valid materials across all subtasks
   - Identify information gaps (subtasks with insufficient results)
   - Note cross-subtask conflicts or inconsistencies
   - Mark any subtasks that need supplementary search
5. If any critical subtask failed or produced no valid results:
   - **Individual failures**: Mark the gap in `information_gaps` context and continue with available materials. The generate phase can work with partial results.
   - **Systemic failure (ALL subtasks failed with zero valid materials)**: Call `workflow` tool with action `"fail"`, a `code` (e.g. `"SEARCH_FAILED"`), and a `message` explaining which subtasks failed and why. Do NOT use `edit` — this step does not support it.
6. **MUST call `workflow` tool**: action = `"next"`, with `instance_id`, `result` object, and `context_patch` object — to advance to the generate phase. **`context_patch` MUST be a JSON object, NOT a string.** Format:
   ```
   workflow(
     action="next",
     instance_id="<instance_id>",
     result={"summary": "Searched N subtasks, collected M valid materials. Key conclusions: ..."},
     context_patch={
       "verified_materials": {"<subtask_slug>": "<full subagent response text>", ...},
       "verified_subtasks": ["<subtask_slug>", ...],
       "information_gaps": ["<subtask_slug with reason>", ...],
       "search_complete": true
     }
   )
   ```
   - `result`: summary object with counts and key conclusions (see below)
   - `context_patch` keys: `verified_materials` (object mapping subtask slugs to full subagent response text), `verified_subtasks` (array of slugs), `information_gaps` (array of gap descriptions), `search_complete` (boolean `true`)
   - Do NOT start generating the report yourself — `workflow.next` will transition to the generate step automatically.

Context writes required before `workflow.next`:

- `verified_materials` (object mapping subtask slugs to their search results — the complete text of each subagent's response, so the generate phase has all materials)
- `verified_subtasks` (array of subtask slugs that were successfully searched)
- `information_gaps` (array of subtasks with insufficient results, with reasons)
- `search_complete` (set to `true`)

Result object should summarize:

- number of subtasks searched
- total valid materials collected
- coverage of information sources per subtask
- key verified conclusions
- remaining information gaps and their severity

Failure handling:

1. Diagnose whether the failure is primarily a:
   - `search_resource_limit` — some sources inaccessible, mark as gap in `information_gaps`
   - `information_scarcity` — expand keywords and retry specific subtasks within the same step
   - `factual_conflict` — mark conflicting content, do not resolve unilaterally
   - `unknown_issue`
2. For individual subtask failures: mark the gap in `information_gaps` context and continue. Call `workflow` tool (action `"next"`) with partial results.
3. For systemic failures (ALL subtasks returned zero valid materials): call `workflow` tool with action `"fail"`, `code` = `"SEARCH_FAILED"`, and a clear `message`. Do NOT use `workflow` tool (action `"edit"`) — this step does not support editing future steps.

Important rules:

- **You MUST call `workflow` tool (action `"next"`) after completing all actions.** Do NOT start generating the report or proceed to the next phase manually — the workflow state machine advances to the generate step only when the `workflow` tool with action `"next"` is called.
- **After the `workflow` tool (action `"next"`) returns, the generate step becomes active. Immediately execute the generate step instructions without stopping or asking the user.**
- All search agents run in parallel — do NOT call them sequentially.
- Each subagent returns results in its task response — no file writing.
- Each subtask should collect ~2 validated materials — quality over quantity.
- Do NOT ignore conflicting facts or forcibly unify contradictory content.
- Do NOT create any directories or write intermediate files.
- Pass all collected materials to the generate phase via `verified_materials` context field.
