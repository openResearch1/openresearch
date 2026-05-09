# Spawn Child That Waits For Parent

This step tests `child_waiting` and `resume_agent`.

Required behavior:

1. If no child has been spawned yet, call `spawn_agent` once. In the child prompt, instruct it to start workflow `simple_test_v1` with flow `child_parent_interaction`, then follow that workflow exactly.
2. After `spawn_agent` returns, stop immediately. Do not call `workflow.next`.
3. When resumed with `child_waiting`, call `resume_agent` for that child with this answer: `parent approved continuation`.
4. After `resume_agent` returns, stop immediately. Do not call `workflow.next`.
5. When resumed with `child_done`, call `workflow.next` with this `context_patch`:

```json
{
  "child_summary": "<the child_done summary>",
  "parent_wait_checked": true
}
```

Rules:

- Do not ask the human user for the child's requested input.
- Use `resume_agent` for `child_waiting`.
- Do not use `list_children` or `bash sleep` to poll.
