# Clarify Idea

Normalize the raw idea into a buildable center node for an idea -> method/theorem -> verification tree.

Required actions:

1. Rewrite the idea into:
   - a core hypothesis
   - a concise scope statement
   - a preferred validation style: `experiment`, `theory`, or `mixed`
   - one conservative operationalization seed that makes the tree buildable:
     - target object: what spectrum is being discussed
     - balance metric: how balance will be measured
     - setting: where this will be tested
   - whether the second layer should lean more toward concrete methods, analytical mechanism claims, or a mix
2. Only if the idea is too ambiguous to choose even one reasonable operationalization seed, use `workflow.wait_interaction` to ask one short clarification question.
3. When resumed after clarification, merge the user's response and finish this step.

Context writes required before `workflow.next`:

- `idea_claim`
- `idea_scope`
- `validation_style`
- `idea_object`
- `idea_metric`
- `idea_setting`
- `idea_branch_style`
- `clarification_notes`

Result object should summarize:

- the normalized hypothesis
- the chosen validation style
- the chosen operationalization seed
- the chosen branch style
- whether user clarification was needed

Important rules:

- Prefer `mixed` when both experiment and theory seem plausible.
- Prefer one concrete operationalization seed over a broad list of possible objects or metrics.
- Ask at most one short clarification unless the idea is genuinely unusable without more detail.
