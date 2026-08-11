# Link Idea Tree

Link the newly created idea tree to existing related atoms or trees conservatively.

Required actions:

1. Read `new_atom_ids` from workflow context.
2. Read `related_atom_ids` from workflow context.
3. If either side is empty, record that linking was skipped.
4. Otherwise invoke `research_tree_link`.
   - Pass the new atom IDs and related existing atom IDs as two unordered groups.
   - Do not prescribe edge direction; `research_tree_link` must orient each relation from its semantics.

Context writes required before `workflow.next`:

- `link_attempted`
- `link_summary`

Result object should summarize:

- whether linking was attempted
- whether any conservative cross-tree links were created

Important rules:

- Do not create dense links.
- It is acceptable to create zero links if the relationship remains unclear.
