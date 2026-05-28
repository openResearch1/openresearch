# Deploy Code To Remote Server

Synchronize experiment code to the remote server when deployment is required.

Required actions:

1. Decide whether deployment is necessary. Typical cases:
   - code changed locally
   - remote dependency files must be read from uploaded code
   - a retry requires updated code on the server
2. Before deployment, update the execution watch to:
   - `status: running`
   - `stage: deploying_code`
   - `message: Syncing code to the remote server`
3. When sync is required, you MUST invoke the `experiment_deploy` subagent.
4. Extract the returned `Remote Path` and save it for later environment setup and run steps.
   - If the experiment already has `remote_code_path`, deployment should use that exact full path.
5. If deployment is not needed because the remote code path is already valid for the current attempt, record that decision explicitly.

Context writes required before `workflow.next`:

- `deploy_required`
- `deploy_done`
- `remote_code_path`

Result object should summarize:

- whether deployment happened
- which remote path will be used

Failure handling:

- If deployment fails because server access or credentials are missing, use `workflow.wait_interaction` and ask for the missing server configuration.
- If deployment fails because the code itself must change, use `workflow.edit` to insert the required recovery path such as `coding`, `run_user_review`, and `deploy_code` before a later retry.

Important rules:

- Do not invent the remote path; use the deploy result.
- User-configured `remote_code_path` is authoritative when present.
- Environment setup should consume `remote_code_path` when project files on the server matter.
- Do not perform the remote code sync yourself when deployment is needed; use `experiment_deploy`.
