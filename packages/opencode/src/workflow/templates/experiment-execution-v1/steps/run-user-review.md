# Ask User Before Remote Execution

Show the user the prepared code changes before remote execution.

Required actions:

- Summarize relevant code changes and execution plan.
- Use `wait_interaction` to ask the user whether to proceed.
- Resume only after receiving the user's reply.
