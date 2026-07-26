# Implement Experiment

Implement the approved plan autonomously using the available coding tools.

1. Work inside the experiment `code_path`. Read outside it when needed, but keep experiment code writes within it.
2. Inspect the existing implementation before editing, make focused changes, and validate them with the most relevant tests or checks.
3. Prepare the code for remote execution, including explicit runtime resource arguments and W&B integration when the experiment requires them. Never hardcode credentials.
4. Do not sync code, mutate the remote runtime, or start the remote experiment before user approval.
5. Summarize the changed files, validation results, proposed remote command, and any environment or resource work that execution may perform.
6. Call `workflow.wait_interaction` and wait for explicit approval to deploy and run.

When resumed:

- If the user approves, call `workflow.next` with `run_approved: true` and a concise implementation and run summary in context.
- If the user requests changes, apply and validate them, present the updated summary, and call `workflow.wait_interaction` again.
- Do not treat an ambiguous response as approval.

Specialist subagents are optional. Use them only when delegation is more effective than acting directly.
