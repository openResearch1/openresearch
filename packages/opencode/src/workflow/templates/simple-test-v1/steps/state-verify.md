# Verify Captured Context

This step confirms that the previous step wrote `net_can` into workflow context when it finished.

Required actions:

- Inspect the current context.
- Confirm that `net_can` exists and has the expected value.
- Only then finish the step.

Rules:

- This step should fail its `can_next` check if `net_can` was not persisted.
