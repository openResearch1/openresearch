# Confirm Required Configurations

Verify that all required remote server and W&B configuration is resolved before planning or execution continues.

Required actions:

1. Resolve server configuration from `remote_server_config` and existing workflow context.
2. Confirm the server config is normalized and complete enough for the selected connection mode when remote execution is required:
   - if `server.mode` is `direct`, confirm:
     - `address`
     - `port`
     - `user`
     - optional `password`
   - if `server.mode` is `ssh_config`, confirm:
     - `host_alias`
     - optional `ssh_config_path`
     - optional `user`
     - optional `password`
   - in either mode, confirm:
     - `resource_root`
3. Confirm `local_resource_root` when the plan or expected resource strategy may require local preparation before upload.
4. Confirm W&B configuration:
   - `wandb_project`
   - `wandb_api_key`
5. If any required field is missing or empty, use `workflow.wait_interaction` and ask the user specifically for the missing fields.
6. When the user replies, resume this same step, merge the received values into context, and only then continue.

Context writes required before `workflow.next`:

- `server`
- `resource_root`
- `local_resource_root` when available
- `wandb_project`
- `wandb_api_key`
- `config_confirmed`

Result object should summarize:

- which configuration values were confirmed
- which values came from saved config vs user input

Important rules:

- Do not continue while any required server or W&B field is unresolved.
- Use `workflow.wait_interaction`, not plain narration, when asking the user for missing configuration.
- Keep the context values normalized so later steps can reuse them directly.
- Do not require `address` or `port` when `server.mode` is `ssh_config`.
- Do not require `host_alias` when `server.mode` is `direct`.
