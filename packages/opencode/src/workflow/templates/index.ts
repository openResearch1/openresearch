import path from "path"
import { ExperimentExecutionWorkflowTemplate, ExperimentExecutionWorkflowTemplateDir } from "./experiment-execution-v1"
import { ResearchIdeaTreeWorkflowTemplate, ResearchIdeaTreeWorkflowTemplateDir } from "./research-idea-tree-v1"
import { SimpleTestWorkflowTemplate, SimpleTestWorkflowTemplateDir } from "./simple-test-v1"
import { DeepResearchWorkflowTemplate, DeepResearchWorkflowTemplateDir } from "./deep-research-v1"

const registry = {
  [SimpleTestWorkflowTemplate.id]: SimpleTestWorkflowTemplate,
  [ExperimentExecutionWorkflowTemplate.id]: ExperimentExecutionWorkflowTemplate,
  [ResearchIdeaTreeWorkflowTemplate.id]: ResearchIdeaTreeWorkflowTemplate,
  [DeepResearchWorkflowTemplate.id]: DeepResearchWorkflowTemplate,
}

const dirs = {
  [SimpleTestWorkflowTemplate.id]: SimpleTestWorkflowTemplateDir,
  [ExperimentExecutionWorkflowTemplate.id]: ExperimentExecutionWorkflowTemplateDir,
  [ResearchIdeaTreeWorkflowTemplate.id]: ResearchIdeaTreeWorkflowTemplateDir,
  [DeepResearchWorkflowTemplate.id]: DeepResearchWorkflowTemplateDir,
}

export namespace WorkflowTemplates {
  export function get(id: string) {
    return registry[id as keyof typeof registry]
  }

  export function list() {
    return Object.values(registry)
  }

  export function step(templateID: string, kind: string) {
    return get(templateID)?.defs[kind]
  }

  export function flow(templateID: string, flowID?: string) {
    const template = get(templateID)
    if (!template) return
    return template.flows[flowID ?? template.default_flow]
  }

  export async function prompt(templateID: string, promptID: string) {
    const dir = dirs[templateID as keyof typeof dirs]
    if (!dir) return
    const file = path.join(dir, "steps", `${promptID}.md`)
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    return text || undefined
  }

  export async function summary(templateID: string, flowID: string) {
    const dir = dirs[templateID as keyof typeof dirs]
    const flow = get(templateID)?.flows[flowID]
    if (!dir || !flow) return
    const file = path.join(dir, "flows", `${flow.summary}.md`)
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    return text || undefined
  }
}
