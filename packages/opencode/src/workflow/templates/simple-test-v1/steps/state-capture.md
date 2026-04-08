# Capture Step Output Into Context

This step tests that a value received in the current step is persisted when the step finishes.

Assume the current step has received this value:

```json
{
  "net_can": "captured_in_current_step"
}
```

Required actions:

- Finish this step with `workflow.next`.
- In that same `workflow.next`, write:

```json
{
  "net_can": "captured_in_current_step"
}
```

Rules:

- Do not delay the write to the next step.
- Do not only mention the value in natural language. Persist it using `context_patch`.
