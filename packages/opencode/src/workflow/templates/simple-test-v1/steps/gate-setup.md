# Prepare Gating Context

This step prepares the dedicated `can_next` validation.

Required actions:

- Enter the next step without writing the required gating fields yet.
- When leaving this step, only write a partial context patch:

```json
{
  "ready": true
}
```

Rules:

- Do not write `token` in this step.
- The next step should initially fail its `can_next` check.
