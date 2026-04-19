# Find Existing Context

Search the current research project for atoms that are clearly related to the normalized idea.

Required actions:

1. Call `atom_query` to inspect existing atoms in the current research project.
2. Identify a conservative shortlist of related atoms, if any.
3. Summarize how those atoms relate to the idea:
   - background facts
   - possible supporting methods
   - possible existing validations
   - possible contradictions or tensions

Context writes required before `workflow.next`:

- `related_atom_ids`
- `related_atom_summary`
- `related_atom_count`

Result object should summarize:

- how many related atoms were found
- what kind of reuse or linkage seems plausible

Important rules:

- Be conservative. Do not mark atoms as related on weak thematic overlap alone.
- It is acceptable to record an empty related set.
