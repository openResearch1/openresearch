# can_next Gate Flow

This flow validates that `can_next` blocks step completion until the required context exists.

Execution outline:

- Start on this flow summary.
- Call `next` to enter `gate_setup`.
- Enter `gate_check` and verify that `next` is rejected until both required fields exist.
- Then satisfy the conditions and complete the flow.

Validation target:

- `gate_check` must not allow `next` unless both `ready == true` and `token != null` are true.
