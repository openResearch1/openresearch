# State Persist Gate Flow

This flow validates that a value received in one step is written into workflow context when that step finishes.

Execution outline:

- Start on this flow summary.
- Call `next` to enter `state_capture`.
- Finish `state_capture` by writing `net_can` using `workflow.next.context_patch`.
- Enter `state_verify` and confirm `net_can` is present in context.
- Complete the flow.

Rules:

- Do not postpone writing `net_can` to a later step.
- The write should happen in the same `workflow.next` call that finishes `state_capture`.
