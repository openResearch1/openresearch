# Fail Path Flow

This flow is used to test explicit workflow failure.

Execution outline:

- Start from the flow summary.
- Call `next` to enter the first step.
- Continue until `fail_test`, then stop the workflow with `workflow.fail`.
