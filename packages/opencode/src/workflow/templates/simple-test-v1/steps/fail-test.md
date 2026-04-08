# Trigger Workflow Failure

This step exists only to test explicit workflow failure handling.

You must call `workflow.fail` from this step.

Use these values:

```json
{
  "code": "TEST_FAIL_PATH",
  "message": "This is an intentional failure from simple_test_v1/fail_path.",
  "detail": "The fail_path flow is used to verify that workflow.fail stops the workflow and reports the reason to the user."
}
```

Rules:

- Do not call `next` in this step.
- Do not call `wait_interaction` in this step.
- The workflow should end in `failed` state.
