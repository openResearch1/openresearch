# Wait For Parent Input

This child step must pause for input from the parent agent.

Required behavior:

1. If no parent answer is present yet, call `workflow.wait_interaction` with message `Child needs parent approval to continue`, then stop.
2. When resumed with the parent answer, call `workflow.next` with this `context_patch`:

```json
{
  "parent_answer": "<the parent answer>",
  "child_wait_checked": true
}
```

Rules:

- Do not ask the human user directly.
- Do not advance until the parent answer is available.
