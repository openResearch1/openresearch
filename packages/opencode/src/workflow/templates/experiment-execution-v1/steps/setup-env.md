# Prepare Remote Environment

Prepare or reuse the remote execution environment before the experiment run.

Required actions:

1. For project-level environment setup, invoke `project_runtime_env_setup` with the selected `remote_server_id` and local `code_path` so the subagent can read local code, inspect the server with `ssh`, choose dependencies, install, and verify.
2. Query project-managed environments with `project_runtime_env_query` for the selected remote server when you only need to inspect existing inventory.
3. Decide whether a managed environment can be reused safely by matching the planned dependency fingerprint or dependency summary, then verifying the remote environment is usable.
4. If a matching successful experience exists for the same `code_path`, use it as a hint, but prefer the project-managed environment inventory as the source of truth.
5. Only invoke `project_runtime_env_setup` when:
   - the environment is missing
   - no project-managed environment record matches the requirement
   - the matching project-managed environment is stale or failed
   - the plan requires packages not present remotely
   - code changes altered dependencies
   - a prior run failure indicates an environment issue
6. Before environment setup, update the execution watch to:
   - `status: running`
   - `stage: setting_up_env`
   - `message: Preparing the remote execution environment`
7. Do not infer packages in this workflow step. Let `project_runtime_env_setup` inspect local code with `read`/`glob`/`grep` and inspect the server with `ssh`.
8. After a setup or successful verification, ensure the project-managed environment inventory is updated with `project_runtime_env_upsert` using the actual `env_name`, spec/fingerprint, server-adapted install plan, verification evidence, and `status: ready`.
9. When this same step is reached again after a failed run, treat it as a recovery pass of the same business action:
   - read `last_error_kind`, `last_error_summary`, and prior environment context
   - repair only the specific blocking issue when possible
   - avoid redoing unrelated setup work

Context writes required before `workflow.next`:

- `env_ready`
- `env_name`
- `env_reused`
- `env_summary`

Result object should summarize:

- whether the environment was reused or configured
- which environment name will be used for the run

Failure handling:

- If setup fails and the issue appears recoverable, use `workflow.edit` to insert `setup_env` and `run_experiment` as future steps when another environment repair attempt should happen later.
- If setup cannot continue because required configuration is missing, use `workflow.wait_interaction`.

Important rules:

- Do not force a rebuild first when trusted successful experience indicates the environment is reusable.
- Do not bypass the project-managed environment inventory; always query it before deciding to rebuild.
- Do not introduce a separate retry step kind; repeated environment repair should reuse `setup_env` itself.
- When project-level environment setup is needed, you MUST invoke the `project_runtime_env_setup` subagent instead of configuring the environment yourself.
- Do not treat dependency-only verification as proof that local project code runs remotely; project code is not synced by project-level setup.
