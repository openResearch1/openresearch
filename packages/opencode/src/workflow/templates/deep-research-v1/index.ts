import { WorkflowSchema } from "../../schema"

export const DeepResearchWorkflowTemplateDir = import.meta.dirname

export const DeepResearchWorkflowTemplate = WorkflowSchema.Template.parse({
  id: "deep_research_v1",
  name: "Deep Research Workflow",
  version: "1.0",
  description: "深度调研全流程：规划→并行搜索验证→生成报告",

  defs: {
    plan_task: {
      kind: "agent_task",
      title: "制定调研计划",
      summary: "分析研究主题，调用 deep_research_plan 子 Agent 生成结构化研究计划（约1-2个子任务），在对话中呈现计划并等待用户确认（不写入文件）",
      prompt: "plan",
      policy: { can_next: ["plan_complete"], can_wait_interaction: true }
    },
    search_verify_task: {
      kind: "agent_task",
      title: "搜索与事实核查",
      summary: "解析计划文本中的子任务，并行启动多个 deep_research_search_verify 子 Agent 进行多源检索和交叉事实验证，每个子任务收集约2篇材料，结果通过 context 传递至生成阶段",
      prompt: "search-verify",
      policy: { can_next: ["search_complete"] }
    },
    generate_task: {
      kind: "agent_task",
      title: "生成调研报告",
      summary: "整合所有已验证材料，调用 deep_research_generate 子 Agent 生成 {keyword_slug}-YYYY-MM-DD.md 报告文件",
      prompt: "generate",
      policy: { can_next: ["report_complete"] }
    },
    finish: {
      kind: "finish",
      title: "调研完成",
      summary: "深度调研流程收尾，确认报告文件存在，向用户总结关键结论和文件路径",
      prompt: "finish",
      policy: {}
    },
    report_failure: {
      kind: "report_failure",
      title: "报告失败并等待用户决策",
      summary: "诊断当前阶段失败原因，展示给用户，根据用户决策动态插入恢复步骤或终止工作流",
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
      title: "Deep Research 默认流程",
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