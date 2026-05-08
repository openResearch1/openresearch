# Child Parent Interaction Flow

This flow validates that a child workflow can request input from its parent agent.

Execution outline:

1. In `child_wait_parent`, call `workflow.wait_interaction` with a clear request for the parent agent.
2. Stop after waiting.
3. When resumed by the parent, write the provided answer into workflow context and call `workflow.next`.
4. Finish `child_wait_finish`.

Rules:

- The expected caller is the parent agent that spawned this session.
- Do not complete the first step before receiving the parent answer.
