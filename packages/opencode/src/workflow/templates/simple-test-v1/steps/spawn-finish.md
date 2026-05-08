# Finish Spawn Wait Test

Complete the spawn-agent workflow test.

Before calling `workflow.next`, verify that workflow context contains:

```json
{
  "spawn_wait_checked": true
}
```

Then call `workflow.next` to complete the workflow.
