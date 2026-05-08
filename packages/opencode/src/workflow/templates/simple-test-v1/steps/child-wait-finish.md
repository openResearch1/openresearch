# Finish Child Wait Test

Complete the child-side wait test.

Before calling `workflow.next`, verify that workflow context contains:

```json
{
  "child_wait_checked": true
}
```

Then call `workflow.next` to complete the child workflow.
