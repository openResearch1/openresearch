# Prepare Remote Resources

Resolve datasets, models, checkpoints, and any other runtime resources needed by the experiment.

Required actions:

1. Determine which resources are required by the current plan and code.
2. Query project inventory only to apply trusted runtime success memory for the stable code root and selected server.
3. Reuse trusted resources without remote checks and do not send them to the resource agent.
4. Invoke `experiment_resource_prepare` with one related batch for resources that are new, missing, stale, implicated by a real run failure, or need experiment-specific preparation.
5. `experiment_resource_prepare` owns inventory lookup, remote reuse or repair, acquisition, preparation, final verification, and ready inventory updates for that unresolved batch.
6. Treat `running` or non-terminal output from the resource agent as not ready; it must never be treated as success.
7. Collect the returned final remote absolute paths and map them to the runtime CLI arguments expected by the code.
8. After a real run meaningfully consumes a resource, merge its trusted `runtime_success` entry without replacing unrelated inventory metadata.
9. Use `todowrite` to track resource preparation work one resource at a time when more than one resource still needs action.
10. Update the execution watch before each concrete resource stage using the appropriate stage:

- `remote_downloading`
- `verifying_resources`

11. When this same step is reached again after a failed run, treat it as another pass of resource preparation:

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

- which resources were reused, downloaded, prepared, or adapted by `experiment_resource_prepare`
- which final remote paths and runtime arguments were resolved

Failure handling:

- If a resource step fails, update the execution watch to `status: failed` for the failing stage before asking the user, retrying, or editing the workflow.
- If runtime findings require remediation before the run can continue, use `workflow.edit` to insert `prepare_resources` and `run_experiment` as needed.

Important rules:

- `running` from `experiment_resource_prepare` is not success.
- Final readiness means usable remote absolute paths are resolved.
- Project-managed resource records are the inventory source of truth, but final readiness still requires remote verification.
- Do not let this step silently continue without verified resource paths when the run depends on them.
- Do not introduce separate retry step kinds for resource preparation; repeat `prepare_resources` when recovery requires it.
- Do not perform remote resource work yourself. Invoke `experiment_resource_prepare` for acquisition, repair, verification, or experiment-specific adaptation.
