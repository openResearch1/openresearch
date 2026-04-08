# State Persist Implicit Flow

This flow tests whether the model will persist a received value even when the current step does not explicitly instruct it to use `context_patch`.

Execution outline:

- Start on this flow summary.
- Call `next` to enter `state_capture_implicit`.
- The current step will mention that it received `net_can`.
- Then enter `state_verify` and observe whether `net_can` was persisted automatically.

Validation target:

- If the model writes `net_can` when finishing `state_capture_implicit`, `state_verify` can complete.
- If the model does not write it, `state_verify` should hit its `can_next` gate.
