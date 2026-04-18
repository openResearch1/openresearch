import { WorkflowSchema } from "../../schema"

export const ResearchIdeaTreeWorkflowTemplateDir = import.meta.dirname

export const ResearchIdeaTreeWorkflowTemplate = WorkflowSchema.Template.parse({
  id: "research_idea_tree_v1",
  name: "Research Idea Tree Workflow",
  version: "1.0",
  description:
    "Turn a user-provided research idea into a validation-oriented atom tree, then connect it to existing atoms conservatively.",
  defs: {
    gather_idea: {
      kind: "gather_idea",
      title: "Gather idea",
      summary: "Extract the raw idea text and determine whether it is usable.",
      prompt: "gather-idea",
      policy: { can_next: [], can_wait_interaction: false, can_edit_future: false, allowed_edit_ops: [] },
    },
    clarify_idea: {
      kind: "clarify_idea",
      title: "Clarify idea",
      summary: "Normalize the idea into a research hypothesis and ask for clarification only when needed.",
      prompt: "clarify-idea",
      policy: { can_next: [], can_wait_interaction: true, can_edit_future: false, allowed_edit_ops: [] },
    },
    find_existing_context: {
      kind: "find_existing_context",
      title: "Find existing context",
      summary: "Inspect existing atoms to find conservative reuse and linking candidates.",
      prompt: "find-existing-context",
      policy: { can_next: [], can_wait_interaction: false, can_edit_future: false, allowed_edit_ops: [] },
    },
    build_idea_tree: {
      kind: "build_idea_tree",
      title: "Build idea tree",
      summary: "Invoke a specialized subagent to build one idea-local validation tree.",
      prompt: "build-idea-tree",
      policy: { can_next: [], can_wait_interaction: false, can_edit_future: false, allowed_edit_ops: [] },
    },
    link_idea_tree: {
      kind: "link_idea_tree",
      title: "Link idea tree",
      summary: "Link the new idea tree to related existing atoms or trees conservatively.",
      prompt: "link-idea-tree",
      policy: { can_next: [], can_wait_interaction: false, can_edit_future: false, allowed_edit_ops: [] },
    },
    review_tree: {
      kind: "review_tree",
      title: "Review tree with user",
      summary: "Show the generated idea tree and wait for user approval or refinement guidance.",
      prompt: "review-tree",
      policy: { can_next: [], can_wait_interaction: true, can_edit_future: true, allowed_edit_ops: ["insert"] },
    },
  },
  flows: {
    default: {
      title: "Default",
      summary: "default",
      steps: ["gather_idea", "clarify_idea", "find_existing_context", "build_idea_tree", "link_idea_tree", "review_tree"],
    },
  },
  default_flow: "default",
})
