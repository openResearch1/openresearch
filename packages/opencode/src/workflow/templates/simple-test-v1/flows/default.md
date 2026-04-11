# Default Flow

This flow is the canonical test for workflow entry behavior.

At `start`, you must verify all of the following before doing anything else:

- The workflow has started successfully.
- `current_step` is empty.
- The workflow is still at the flow entry stage.
- This markdown summary is the content returned for `start`.

Execution outline:

- Review this flow summary first.
- Call `next` exactly once to enter the first step.
- After the first `next`, confirm that the workflow has entered the `prepare` step.
- Then complete the remaining steps in order.

Rules:

- `start` does not enter step 1.
- The first `next` is the transition from flow summary into the first step.
