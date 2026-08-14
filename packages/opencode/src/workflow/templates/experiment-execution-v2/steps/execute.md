# Execute Experiment

Own the remaining lifecycle autonomously. Decide what is needed from the current state instead of following a fixed sequence.

Use the available tools directly to handle relevant work such as:

- selecting and verifying the configured remote server
- reusing or preparing project-managed environments and resources
- syncing the current experiment code
- launching and inspecting managed remote tasks
- diagnosing failures and retrying recoverable work
- registering W&B monitoring immediately after a successful launch
- recording the actual runtime setup and committing experiment changes when appropriate

Keep these boundaries:

- Prefer verified reusable environments and resources over rebuilding them.
- Use managed remote task tooling for long-running work. Pass the unattended business command or multiline shell script directly; do not invent SSH, screen/nohup, polling, or managed-log wrappers.
- Keep credentials out of source code and pass W&B configuration at runtime.
- Ask the user only when required configuration is missing, a decision is genuinely ambiguous, or recovery would materially change the approved code or run intent.
- If recovery materially changes the approved code or run intent, present the changes and call `workflow.wait_interaction` before deploying or running again.
- Update the execution watch at meaningful milestones without turning those milestones into workflow steps.

Stay in this phase while diagnosing and recovering. Once the run has started successfully and durable monitoring is registered, call `workflow.next` with `execution_complete: true` and summarize the effective command, runtime, resources, remote task, and W&B run.

If the experiment cannot be executed after reasonable recovery, call `workflow.fail` with the concrete blocker and observed evidence.
