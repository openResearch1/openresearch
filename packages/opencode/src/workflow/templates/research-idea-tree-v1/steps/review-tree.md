# Review Tree With User

Present the new idea tree and wait for user approval or refinement guidance.

Required actions:

1. Summarize:
   - the normalized idea
   - how many new atoms were created
   - how the tree is distributed across:
     - the central idea atom
     - method/theorem atoms
     - verification atoms
   - whether any related existing atoms were found
   - whether any links were created
2. Use `workflow.wait_interaction` to ask whether the user:
   - accepts the tree
   - wants further refinement
   - wants the tree to lean more toward theory or experiment
3. When resumed:
   - if the user accepts, finish the workflow
   - if the user wants refinement, use `workflow.edit` to insert:
     - `find_existing_context`
     - `build_idea_tree`
     - `link_idea_tree`
     - `review_tree`
       after the current step, then continue

Context writes required before `workflow.next`:

- `idea_review_decision`
- `idea_review_notes`

Result object should summarize:

- whether the user accepted the tree
- whether a refinement loop was inserted

Important rules:

- Do not keep refining without user direction.
- If the user requests refinement, preserve the current tree and extend or adjust incrementally rather than pretending the previous build never happened.
- Keep the review summary aligned with the intended skeleton:
  - idea -> method/theorem -> verification
