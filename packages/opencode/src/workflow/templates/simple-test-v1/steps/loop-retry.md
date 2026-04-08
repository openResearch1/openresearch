# Loop Retry Step

This step exists to test the automatic workflow guard.

You may use `workflow.edit` to insert `loop_retry` again after the current step.

Rules:

- If `loop_retry` is inserted more than three times in the workflow instance, the workflow should automatically fail.
- This step is only for testing the repeated-kind protection.
