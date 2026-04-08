# Check can_next Gating

This step exists to verify that `can_next` enforcement is working.

The step policy requires both of the following before `next` is allowed:

- `ready == true`
- `token != null`

Required test procedure:

1. First try `workflow.next` without adding `token`.
2. Confirm that the tool rejects the action with `NEXT_NOT_ALLOWED`.
3. Then call `workflow.next` again, this time with:

```json
{
  "token": "gate_ok"
}
```

Rules:

- You must verify that the first `next` attempt fails.
- Only after that failure is observed should you provide `token` and try again.
