import { WorkflowSchema } from "../../schema"

export const SimpleTestWorkflowTemplateDir = import.meta.dirname

export const SimpleTestWorkflowTemplate = WorkflowSchema.Template.parse({
  id: "simple_test_v1",
  name: "Simple Test Workflow",
  version: "1.0",
  description: "Minimal workflow for validating start, next, edit, wait, fail, and inspect behavior.",
  defs: {
    prepare: {
      kind: "prepare",
      title: "Prepare test input",
      summary: "Initialize the workflow context and confirm the tool starts correctly.",
      prompt: "prepare",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: true,
        allowed_edit_ops: ["insert", "delete"],
      },
    },
    prepare_retry: {
      kind: "prepare_retry",
      title: "Prepare test input",
      summary: "Re-run the preparation step using the same instructions as the original setup.",
      prompt: "prepare-retry",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: true,
        allowed_edit_ops: ["insert", "delete"],
      },
    },
    review: {
      kind: "review",
      title: "Review current state",
      summary: "Read the current step detail and decide whether to continue.",
      prompt: "review",
      policy: {
        can_next: [],
        can_wait_interaction: true,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    fail_test: {
      kind: "fail_test",
      title: "Trigger workflow failure",
      summary: "Use this step to test explicit workflow failure reporting.",
      prompt: "fail-test",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    loop_retry: {
      kind: "loop_retry",
      title: "Loop retry step",
      summary: "A retry step used to test automatic failure when the same kind is inserted too many times.",
      prompt: "loop-retry",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: true,
        allowed_edit_ops: ["insert"],
      },
    },
    gate_setup: {
      kind: "gate_setup",
      title: "Prepare gating context",
      summary: "Write context fields used by the next step's can_next conditions.",
      prompt: "gate-setup",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    gate_check: {
      kind: "gate_check",
      title: "Check can_next gating",
      summary: "This step can only complete when ready == true and token != null.",
      prompt: "gate-check",
      policy: {
        can_next: ["ready == true", "token != null"],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    state_capture: {
      kind: "state_capture",
      title: "Capture step output into context",
      summary: "Write a received value into workflow context when finishing the current step.",
      prompt: "state-capture",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    state_capture_implicit: {
      kind: "state_capture_implicit",
      title: "Capture value without explicit persistence instruction",
      summary: "Receive a value in this step",
      prompt: "state-capture-implicit",
      policy: {
        can_next: ["net_can != null"],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    state_verify: {
      kind: "state_verify",
      title: "Verify captured context",
      summary: "Confirm that the previous step wrote the required value into context.",
      prompt: "state-verify",
      policy: {
        can_next: ["net_can != null"],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    state_finish: {
      kind: "state_finish",
      title: "Finish state persistence test",
      summary: "Finish the dedicated state persistence validation flow.",
      prompt: "state-finish",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    finish_gate: {
      kind: "finish_gate",
      title: "Finish can_next test",
      summary: "Complete the dedicated can_next validation flow.",
      prompt: "finish-gate",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    finish: {
      kind: "finish",
      title: "Finish workflow",
      summary: "Complete the workflow and verify the instance reaches completed state.",
      prompt: "finish",
      policy: {
        can_next: [],
        can_wait_interaction: false,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
  },
  flows: {
    default: {
      title: "Default",
      summary: "default",
      steps: ["prepare", "review", "finish"],
    },
    retry_path: {
      title: "Retry Path",
      summary: "retry-path",
      steps: ["prepare", "prepare_retry", "review", "finish"],
    },
    fail_path: {
      title: "Fail Path",
      summary: "fail-path",
      steps: ["prepare", "fail_test"],
    },
    loop_guard_path: {
      title: "Loop Guard Path",
      summary: "loop-guard-path",
      steps: ["prepare", "loop_retry", "finish"],
    },
    can_next_gate: {
      title: "can_next Gate",
      summary: "can-next-gate",
      steps: ["gate_setup", "gate_check", "finish_gate"],
    },
    state_persist_gate: {
      title: "State Persist Gate",
      summary: "state-persist-gate",
      steps: ["state_capture", "state_verify", "state_finish"],
    },
    state_persist_implicit: {
      title: "State Persist Implicit",
      summary: "state-persist-implicit",
      steps: ["state_capture_implicit", "state_verify", "state_finish"],
    },
  },
  default_flow: "default",
})
