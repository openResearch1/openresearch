# Finish Workflow

Complete the workflow only after the expected context markers are present.

Before calling `workflow.next`, confirm that workflow context contains all of these fields:

- `prepare_marker`
- `prepare_checked`
- `review_marker`
- `last_review_reply_processed`

Rules:

- If any required field is missing, do not complete the workflow.
- No further edits are needed in the final step.
