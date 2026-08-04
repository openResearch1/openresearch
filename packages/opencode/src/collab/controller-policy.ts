export namespace ControllerPolicy {
  export const Roles = ["controller", "research_main", "atom", "experiment", "leaf"] as const
  export type Role = (typeof Roles)[number]
  export type ContextRole = Role | "task" | "blocked"
  export type Channel = "direct" | "spawn" | "task" | "workflow"

  const common = ["research", "explore", "general"]

  export function targets(input: { role: ContextRole; channel: Channel; agent?: string }) {
    if (input.channel === "workflow") return []
    if (input.channel === "direct") {
      if (input.role === "controller") return ["controller"]
      if (input.role === "research_main") return ["research", "plan", "build"]
      if (input.role === "atom") return ["research", "plan", "build"]
      if (input.role === "experiment") return ["experiment", "plan", "build"]
      if (input.role === "leaf") return input.agent ? [input.agent] : []
      return []
    }
    if (input.channel === "spawn") {
      if (input.role === "controller") return ["research"]
      if (input.role === "research_main") return [...common, "reviewer"]
      if (input.role === "atom") return common
      if (input.role === "experiment") return ["project_runtime_env_setup", "experiment_resource_prepare"]
      return []
    }
    if (input.role === "research_main" || input.role === "atom") return common
    if (input.role === "leaf") return input.agent && common.includes(input.agent) ? common : []
    if (input.role === "experiment") return ["experiment_plan", "experiment_commit"]
    return []
  }

  export function allows(input: { role: ContextRole; channel: Channel; target: string; agent?: string }) {
    return targets(input).includes(input.target)
  }
}
