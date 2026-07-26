import { WorkflowSchema } from "../../schema"

export const ExperimentExecutionV2WorkflowTemplateDir = import.meta.dirname

export const ExperimentExecutionV2WorkflowTemplate = WorkflowSchema.Template.parse({
  id: "experiment_execution_v2",
  name: "Experiment Execution Workflow",
  version: "2.0",
  description:
    "Lightweight experiment flow with autonomous planning, implementation, and execution separated by user approval gates.",
  defs: {
    plan: {
      kind: "plan",
      title: "Plan experiment",
      summary: "Understand the experiment, prepare a plan, and wait for user approval.",
      prompt: "plan",
      policy: {
        can_next: ["plan_approved == true"],
        can_wait_interaction: true,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    implement: {
      kind: "implement",
      title: "Implement experiment",
      summary: "Implement and validate the approved plan, then wait for approval to run it remotely.",
      prompt: "implement",
      policy: {
        can_next: ["run_approved == true"],
        can_wait_interaction: true,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
    execute: {
      kind: "execute",
      title: "Execute experiment",
      summary: "Prepare the remote runtime, launch the experiment, register monitoring, and recover when needed.",
      prompt: "execute",
      policy: {
        can_next: ["execution_complete == true"],
        can_wait_interaction: true,
        can_edit_future: false,
        allowed_edit_ops: [],
      },
    },
  },
  flows: {
    default: {
      title: "Default",
      summary: "default",
      steps: ["plan", "implement", "execute"],
    },
  },
  default_flow: "default",
})
