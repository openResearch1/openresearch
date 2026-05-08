# Spawn Async Agent And Wait

This step is specifically for testing `spawn_agent` inside an active workflow.

Required behavior before completion:

1. If no `child_done` result is present yet, call `spawn_agent` once with any available agent type and a short prompt asking the child to return the text `spawn workflow child complete`.
2. After `spawn_agent` returns, stop the turn immediately. Do not call `workflow.next` yet.
3. When resumed with the child's `child_done` summary, call `workflow.next` with this `context_patch`:

```json
{
  "child_summary": "<the child_done summary>",
  "spawn_wait_checked": true
}
```

Rules:

- Do not use `list_children` to poll.
- Do not use `bash sleep` or other waiting workarounds.
- Do not advance until the child result is available.
