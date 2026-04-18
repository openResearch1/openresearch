# Gather Idea

Extract the raw idea text that should be turned into a validation-oriented atom tree.

Required actions:

1. Read the latest user message and the existing workflow context.
2. Resolve the best available raw idea text.
   - Prefer `idea_text` already present in workflow context.
   - Otherwise extract the main idea from the latest user message.
3. If no usable idea can be extracted, use `workflow.fail` with a clear reason.

Context writes required before `workflow.next`:

- `idea_text`
- `idea_summary`

Result object should summarize:

- the extracted idea text
- whether it came directly from context or was inferred from the user message

Important rules:

- Do not rewrite the idea into a final research tree here.
- Keep the raw idea close to the user's original intent.
