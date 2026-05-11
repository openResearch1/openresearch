import { WorkflowSchema } from "../../schema"

export const DeepResearchWorkflowTemplateDir = import.meta.dirname

export const DeepResearchWorkflowTemplate = WorkflowSchema.Template.parse({
  id: "deep_research_v1",
  name: "Deep Research Workflow",
  version: "1.0",
  description: "Deep research full workflow: Plan → Parallel Search-Verify → Generate Report",

  defs: {
    plan_task: {
      kind: "agent_task",
      title: "Create Research Plan",
      summary: "Analyze the research topic, invoke the deep_research_plan subagent to generate a structured research plan (~2-3 subtasks), present the plan in conversation and wait for user confirmation (no file writes)",
      prompt: "plan",
      policy: { can_next: ["plan_complete"], can_wait_interaction: true }
    },
    search_verify_task: {
      kind: "agent_task",
      title: "Search & Fact Verification",
      summary: "Parse subtasks from plan text, launch multiple deep_research_search_verify subagents in parallel for multi-source retrieval and cross fact verification, collect ~3 materials per subtask, pass results to generate phase via context",
      prompt: "search-verify",
      policy: { can_next: ["search_complete"] }
    },
    generate_task: {
      kind: "agent_task",
      title: "Generate Research Report",
      summary: "Integrate all verified materials, invoke the deep_research_generate subagent to produce the {keyword_slug}-YYYY-MM-DD.md report file",
      prompt: "generate",
      policy: { can_next: ["report_complete"] }
    },
    finish: {
      kind: "finish",
      title: "Research Complete",
      summary: "Finalize the deep research workflow, confirm the report file exists, summarize key conclusions and file path to the user",
      prompt: "finish",
      policy: {}
    },
    report_failure: {
      kind: "report_failure",
      title: "Report Failure & Await User Decision",
      summary: "Diagnose the failure cause at the current phase, present to the user, and dynamically insert recovery steps or terminate the workflow based on user decision",
      prompt: "report-failure",
      policy: {
        can_next: [],
        can_wait_interaction: true,
        can_edit_future: true,
        allowed_edit_ops: ["insert", "delete"],
      },
    },
  },

  flows: {
    default: {
      title: "Deep Research Default Flow",
      summary: "default",
      steps: ["plan_task", "search_verify_task", "generate_task", "finish"]
    },
    error_recovery: {
      title: "Error Recovery",
      summary: "error-recovery",
      steps: ["report_failure", "finish"],
    },
  },
  default_flow: "default",
})