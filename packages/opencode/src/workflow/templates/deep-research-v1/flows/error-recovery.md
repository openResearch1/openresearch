# Error Recovery Flow

This flow is entered when a phase in the deep research workflow encounters an unrecoverable error. It pauses for user direction and either retries the failed phase or terminates the workflow.

## Execution Process
1. The `report_failure` step diagnoses what went wrong — which phase failed, the specific error, and what was completed successfully.
2. Present the diagnosis to the user and pause via `workflow.wait_interaction`.
3. Based on user decision, dynamically insert recovery steps (`plan_task`, `search_verify_task`, or `generate_task`) via `workflow.edit` before continuing to finish.
4. If the user chooses to stop, call `workflow.fail` to terminate.
