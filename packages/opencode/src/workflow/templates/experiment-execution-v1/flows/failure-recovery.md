# Failure Recovery Flow

This flow is for focused recovery after a failed run.

Execution outline:

- Review the recovery summary first.
- Call `next` to enter the first step.
- Repair the environment, retry the run, and report the outcome.
