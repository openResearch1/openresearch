# Prepare Test Input

This is a workflow instruction test step.

You must do the following before leaving this step:

1. Confirm that this is the first real step entered after the flow summary stage.
2. Call `workflow.inspect` for the current instance.
3. When calling `workflow.next`, include this `context_patch`:

```json
{
  "prepare_marker": "from_prepare_md",
  "prepare_checked": true
}
```

Rules:

- Do not skip this step.
- Do not claim that `start` already entered this step.
- Do not move to the next step unless both `prepare_marker` and `prepare_checked` are written into workflow context.
