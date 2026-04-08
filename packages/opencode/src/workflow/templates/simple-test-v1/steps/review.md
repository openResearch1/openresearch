# Review Current State

This step validates that workflow instructions can pause and resume execution.

You must do the following:

1. Call `workflow.wait_interaction` in this step.
2. Use:
   - `reason`: `review_wait_test`
   - `message`: `Please reply: review ok`
3. Do not call `workflow.next` before user input is received.
4. Only after the user replies "review ok" call `workflow.next` with this `context_patch`:

```json
{
  "review_marker": "from_review_md",
  "last_review_reply_processed": true
}
```

Rules:

- This step must always enter `wait_interaction` before completion.
- Do not skip the wait-and-resume behavior.
