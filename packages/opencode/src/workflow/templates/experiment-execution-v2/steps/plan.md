# Plan Experiment

Understand the research goal and prepare the smallest useful experiment plan. Work autonomously inside this phase; the workflow only requires user approval before implementation.

1. Resolve the current experiment with `experiment_query` and inspect its atom, existing plan, code, prior runs, runtime configuration, and reusable experience as relevant.
2. Clarify missing information only when it cannot be inferred safely from the available context or tools.
3. Create or update the experiment plan. You may do this directly or use a specialist subagent when it is genuinely useful.
4. Do not modify experiment code in this phase.
5. Present a concise plan covering the hypothesis, code changes, validation, remote execution intent, resources, and expected evidence.
6. Call `workflow.wait_interaction` and wait for the user's explicit approval.

When resumed:

- If the user approves, call `workflow.next` with `plan_approved: true` and a concise plan summary in context.
- If the user requests changes, revise the plan, present the updated version, and call `workflow.wait_interaction` again.
- Do not treat an ambiguous response as approval.

Use `experiment_execution_watch_init` or `experiment_execution_watch_update` when useful for visible progress, but do not create artificial substeps only to update status.
