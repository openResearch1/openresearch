# Loop Guard Path Flow

This flow is used to test the automatic retry-loop guard.

Execution outline:

- Start from the flow summary.
- Call `next` to enter the first step.
- Only insert `loop_retry` when intentionally testing the repeated-kind protection.
