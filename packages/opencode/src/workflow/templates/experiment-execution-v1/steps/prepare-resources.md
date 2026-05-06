# Prepare Remote Resources

Resolve datasets, models, checkpoints, and any other runtime resources needed by the experiment.

Required actions:

1. Determine which resources are required by the current plan and code.
2. Query project-managed resources with `project_runtime_resource_query` for the selected remote server and each required resource key.
3. If a matching successful experience records reusable resource paths for this `code_path`, use it as a hint, but prefer the project-managed resource inventory as the source of truth.
4. All resources must resolve to remote absolute paths under `resource_root` unless the plan explicitly states otherwise.
5. First check whether each managed resource record is `ready`, matches the requirement/fingerprint when known, and is still valid remotely.
6. Only after inventory and remote reuse checks, invoke `project_runtime_resource_download` for resources that are missing from the project inventory, stale, failed, invalid remotely, or require network download.
7. Do not ask `experiment_resource_prepare` to download resources. If it reports `project_download_required`, invoke `project_runtime_resource_download` before trying preparation again.
8. After project-level download or reuse succeeds, invoke `experiment_resource_prepare` when the experiment needs remote path confirmation, directory creation, extraction, conversion, symlinks, manifests, copying/moving, or layout adaptation.
9. Treat `running` or non-terminal output from any resource subagent as not ready; it must never be treated as success.
10. After a resource is reused, downloaded, prepared, or successfully verified, update the project-managed resource inventory with `project_runtime_resource_upsert` using the final target path, source/verify/fingerprint when known, and `status: ready` when the path is reusable at project level.
11. Collect the final remote absolute paths and map them to the runtime CLI arguments expected by the code.
12. Use `todowrite` to track resource preparation work one resource at a time when more than one resource still needs action.
13. Update the execution watch before each concrete resource stage using the appropriate stage:

- `remote_downloading`
- `verifying_resources`

14. When this same step is reached again after a failed run, treat it as another pass of resource preparation:

- reuse prior `resolved_resources` and retry state from context
- only redo the resource work affected by the last failure
- avoid discarding already verified resource paths

Context writes required before `workflow.next`:

- `resources_required`
- `resolved_resources`
- `resource_ready`
- `resource_summary`
- `resource_retry_state`

Result object should summarize:

- which resources were reused
- which were downloaded by `project_runtime_resource_download`
- which were prepared or adapted by `experiment_resource_prepare`
- which final remote paths and runtime arguments were resolved

Failure handling:

- If a resource step fails, update the execution watch to `status: failed` for the failing stage before asking the user, retrying, or editing the workflow.
- If runtime findings require remediation before the run can continue, use `workflow.edit` to insert `prepare_resources` and `run_experiment` as needed.

Important rules:

- `running` from `project_runtime_resource_download` or `experiment_resource_prepare` is not success.
- Final readiness means usable remote absolute paths are resolved.
- Project-managed resource records are the inventory source of truth, but final readiness still requires remote verification.
- Do not let this step silently continue without verified resource paths when the run depends on them.
- Do not introduce separate retry step kinds for resource preparation; repeat `prepare_resources` when recovery requires it.
- Do not perform remote download work yourself. Invoke `project_runtime_resource_download` for large or network downloads after query/reuse checks.
- Do not perform experiment-specific remote resource adaptation yourself. Invoke `experiment_resource_prepare`.
