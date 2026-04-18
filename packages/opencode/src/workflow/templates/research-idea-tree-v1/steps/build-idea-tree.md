# Build Idea Tree

Build one new idea-local tree for the current idea with the structure:

- idea atom
- method/theorem atoms downstream of the idea
- verification atoms downstream of those method/theorem atoms

Required actions:

1. Invoke `research_idea_tree_build`.
2. Pass it:
   - the raw idea text
   - the normalized hypothesis
   - the chosen operationalization seed:
     - target object
     - balance metric
     - setting
   - the chosen branch style
   - the validation style
   - any related atom IDs or summaries as background and later linking hints only
3. Extract the created atom IDs from the subagent's final response.

Context writes required before `workflow.next`:

- `new_atom_ids`
- `new_atom_count`
- `idea_tree_summary`

Result object should summarize:

- how many atoms were created
- what the new tree is trying to validate
- how the tree is structured

Important rules:

- The new tree must be idea-local only.
- Do not create cross-tree relations in this step.
- The main skeleton must be:
  - one central idea atom
  - several method/theorem atoms pointed to by the idea atom or formally/analytically attached to it
  - several verification atoms pointed to by those method/theorem atoms via `validates`
- The structure must obey `research.txt` relation semantics, especially:
  - source is prior
  - target is downstream
  - `validates` must be `method/theorem -> verification`
- Related existing atoms may inform wording or later linking, but must not determine the main skeleton of the new tree.
- If the subagent reused an existing idea-local tree instead of creating duplicates, record that clearly.
