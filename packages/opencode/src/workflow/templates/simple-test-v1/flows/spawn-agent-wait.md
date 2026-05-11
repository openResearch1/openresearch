# Spawn Agent Wait Flow

This flow validates that `spawn_agent` can be used inside a running workflow.

Execution outline:

1. Enter the `spawn_wait` step.
2. In `spawn_wait`, call `spawn_agent` exactly once.
3. End the turn immediately after `spawn_agent` returns.
4. After the framework resumes with `child_done`, write the child summary into workflow context and call `workflow.next`.
5. Complete `spawn_finish` normally.

Rules:

- Do not call `workflow.next` in the same turn that creates the child agent.
- Do not poll with `list_children` or wait with shell sleeps.
- The workflow runner must remain idle until the child reports back.
