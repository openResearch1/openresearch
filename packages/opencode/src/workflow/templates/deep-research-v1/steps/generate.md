# Generate Research Report — Phase 3/4: Generate

Integrate verified materials and produce the final research report file. **The user explicitly requested this .md report — it is the deliverable, not a proactive document.** Your job is to save it to disk.

## Execution — 5 steps

### 1. Get context
Retrieve from workflow context: `plan_text`, `verified_materials`, `keyword_slug`, `research_topic`.

### 2. Get the file path
Run this bash command (use the actual `<keyword_slug>` from context):

```bash
echo "$(pwd)/<keyword_slug>-$(date +%Y-%m-%d).md"
```

Store the full path. Example: `/c/Users/Double/research_project_1/weakly-supervised-rl-icml-2026-2026-05-06.md`

### 3. Get report content from subagent

```
task(description="Generate: <research_topic>", subagent_type="deep_research_generate", prompt="Generate the full research report in markdown. Return COMPLETE content — do not call write/edit tools. Language: match the user's query.\n\nTopic: <topic>\n\nPlan:\n<plan_text>\n\nVerified Materials:\n<verified_materials>")
```

### 4. SAVE THE FILE — read then write, in order

The `write` tool requires a `read` call on the same file path before overwriting. Make these TWO calls **sequentially** (not parallel):

**First:**
```
read(file_path="<path from step 2>")
```
If `read` fails (file doesn't exist yet) — ignore the error. Proceed to write.

**Second:**
```
write(file_path="<path from step 2>", content="<full markdown from step 3>")
```

If `write` fails with "must read before overwriting": call `read(file_path="<path>")` once more, then immediately retry `write(file_path="<path>", content="...")`.

### 5. Advance workflow

```
workflow(action="next", instance_id="<id>", result={"summary": "Report saved to <path>"}, context_patch={"report_title": "<title>", "report_path": "<path from step 2>", "core_conclusions": [...], "report_complete": true})
```

After `workflow.next` returns, immediately run the finish step.

## Report structure (pass to subagent)

1. Executive Summary 2. Research Background 3. Subtask Analysis (one chapter each) 4. Cross-Cutting Analysis 5. Conclusions 6. Risk Warnings & Limitations. All papers: `[《Title》](URL)` with 2-4 sentence intro. No separate References.

## Rules

- This .md report IS the user's explicitly requested deliverable — not a proactive document.
- `read` before `write`, always, in that order, sequentially.
- Report language = user's query language.
- `result` and `context_patch` are native JSON objects, not strings.
