# Spawn Agent Parent Wait Flow

This flow validates that a spawned child workflow can call `workflow.wait_interaction` and wait for its parent agent instead of a human user.

Execution outline:

1. Enter `parent_wait_child`.
2. Spawn a child agent and instruct it to run `simple_test_v1` with flow `child_parent_interaction`.
3. Stop after `spawn_agent` returns and wait for `child_waiting`.
4. When `child_waiting` arrives, call `resume_agent` with the requested answer.
5. Stop again and wait for `child_done`.
6. Write the child summary into workflow context and call `workflow.next`.
7. Finish `parent_wait_finish`.

Rules:

- Do not answer the child's wait by asking the human user.
- Do not call `workflow.next` until `child_done` is available.
- Use `resume_agent` to send the parent answer back to the waiting child.
