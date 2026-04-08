# Prepare Test Input Retry

This is the retry version of the preparation step.

You must confirm all of the following before leaving this step:

1. The current step kind is `prepare_retry`.
2. The current step id is not the same as the original `prepare` step id.

Then call `workflow.next` with this `context_patch`:

```json
{
  "retry_marker": "from_prepare_retry_md"
}
```

Rules:

- This step must only be reached from a predefined inserted kind.
- Do not describe this step as a custom runtime-generated step.
