# Finish Parent Wait Test

Complete the parent-side wait test.

Before calling `workflow.next`, verify that workflow context contains:

```json
{
  "parent_wait_checked": true
}
```

Then call `workflow.next` to complete the workflow.
