# Report Repeated Failure To User

Summarize repeated failures and ask the user how to proceed.

Required actions:

- Explain the failed attempts and likely cause.
- Use `wait_interaction` to ask the user whether to retry, revise, or stop.
- Resume only after the user's message is available.
