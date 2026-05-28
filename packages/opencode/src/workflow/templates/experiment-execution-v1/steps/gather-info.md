# Gather Experiment Information

Collect the experiment metadata, research context, and any reusable successful runtime information needed by later steps.

Required tools and actions:

1. Call `experiment_query` with no parameters and extract at least:
   - `exp_id`
   - `atom_id`
   - `code_path`
   - `remote_code_path`
   - `exp_plan_path`
   - `remote_server_id`
   - `remote_server_config`
   - existing run folders if present
2. Read the linked atom's claim and evidence using `atom_query` plus file reads so you understand the research target before planning or coding.
3. Derive `code_id` from the current `code_path` file name stem and check `./.openresearch/successful/<code_id>.md`.
4. Only trust a successful note when its recorded `code_path` matches the current experiment `code_path`.
5. If a matching successful note exists, extract and record:
   - reusable server information
   - reusable environment name
   - reusable dataset/model/resource paths
   - operational notes
6. At the start of this step, ensure the execution watch exists. If it has not been initialized yet, initialize it with `experiment_execution_watch_init`.

Context writes required before `workflow.next`:

- `exp_id`
- `atom_id`
- `code_path`
- `remote_code_path`
- `exp_plan_path`
- `remote_server_id`
- `remote_server_config`
- `code_id`
- `successful_experience_found`
- `successful_experience_summary`
- `successful_experience_server`
- `successful_experience_env`
- `successful_experience_resources`
- `execution_watch_initialized`

Result object should summarize:

- what experiment was resolved
- whether atom context was read
- whether a matching successful note was found
- whether the execution watch was initialized

Important rules:

- Do not skip atom context reading.
- Do not assume a successful note is reusable unless `code_path` matches.
- If required experiment metadata is missing, stop and use `workflow.fail` with a clear reason.
- Entering this step should begin by making sure the execution watch is initialized.
