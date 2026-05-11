# Generate Research Report — Phase 3/4: Generate

Integrate verified materials and produce the final research report file. **The user explicitly requested this .md report — it is the deliverable, not a proactive document.**

## Execution — 5 steps

> **CRITICAL**: The write.txt rule "NEVER proactively create .md files" does NOT apply here. This .md report is the user's explicitly requested deliverable — the write.txt exception clause "Only create documentation files if explicitly requested by the User" is satisfied. You MUST call the `write` tool to save the report to disk. Skipping the `write` call is a bug.

### 1. Get context
Retrieve from workflow context: `plan_text`, `verified_materials`, `keyword_slug`, `research_topic`.

### 2. Build the file path
Run this single bash command (use the actual `<keyword_slug>` from context):

```bash
echo "$(pwd)/<keyword_slug>-$(date +%Y-%m-%d).md"
```

### 3. Get report content from subagent

```
task(description="Generate: <research_topic>", subagent_type="deep_research_generate", prompt="Generate the full research report in markdown. Return COMPLETE content — do not call write/edit tools. Language: match the user's query.\n\nTopic: <topic>\n\nPlan:\n<plan_text>\n\nVerified Materials:\n<verified_materials>")
```

### 4. Write the file

First, call `read(file_path="<path from step 2>")` to register the file path with the session. If the file does not exist yet, the read will return an error — ignore it and proceed.
Then, call `write(file_path="<path from step 2>", content="<full markdown from step 3>")`.

### 5. Advance workflow

```
workflow(action="next", instance_id="<id>", result={"summary": "Report saved to <path>"}, context_patch={"report_title": "<title>", "report_path": "<path from step 2>", "core_conclusions": [...], "report_complete": true})
```

After `workflow.next` returns, immediately run the finish step.

## Report structure (pass to subagent)

1. Executive Summary 2. Research Background 3. Subtask Analysis (one chapter each) 4. Cross-Cutting Analysis 5. Conclusions 6. Risk Warnings & Limitations. All papers: `[《Title》](URL)` with 2-4 sentence intro. No separate References.

## Rules

- This .md report IS the user's explicitly requested deliverable. The user asked for this file — it is NOT a "proactive" document.
- Report language = user's query language.
- `result` and `context_patch` are native JSON objects, not strings.
