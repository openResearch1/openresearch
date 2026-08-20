import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { PermissionNext } from "../../src/permission/next"

// Helper to evaluate permission for a tool with wildcard pattern
function evalPerm(agent: Agent.Info | undefined, permission: string): PermissionNext.Action | undefined {
  if (!agent) return undefined
  return PermissionNext.evaluate(permission, "*", agent.permission).action
}

test("returns default native agents when no config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).toContain("build")
      expect(names).toContain("plan")
      expect(names).toContain("general")
      expect(names).toContain("explore")
      expect(names).toContain("compaction")
      expect(names).toContain("title")
      expect(names).toContain("summary")
    },
  })
})

test("composes shared prompts only into selected agents", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const plan = await Agent.get("plan")
      const general = await Agent.get("general")
      const explore = await Agent.get("explore")
      const experiment = await Agent.get("experiment")
      const research = await Agent.get("research")
      const controller = await Agent.get("controller")

      expect(build?.prompt).toBeUndefined()
      expect(plan?.prompt).toBeUndefined()
      expect(general?.prompt).toBeUndefined()
      expect(explore?.prompt).not.toContain("## Interaction and response style")

      expect(experiment?.prompt).toContain("## Interaction and response style")
      expect(experiment?.prompt).toContain("## Workspace safety")
      expect(experiment?.prompt).not.toContain("## Code editing")
      expect(experiment?.prompt).not.toContain("## Experiment code editing")
      expect(experiment?.prompt).toContain("You are the autonomous experiment agent")

      expect(research?.prompt).toContain("## Interaction and response style")
      expect(research?.prompt).toContain("## Workspace safety")
      expect(research?.prompt).not.toContain("## Code editing")
      expect(research?.prompt).toContain("## Atom model")

      expect(controller?.prompt).toContain("## Interaction and response style")
      expect(controller?.prompt).not.toContain("## Workspace safety")
      expect(controller?.prompt).not.toContain("## Code editing")
      expect(controller?.prompt).toContain("You are the Controller for an OpenResearch project")
    },
  })
})

test("build agent has correct default properties", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.mode).toBe("primary")
      expect(build?.native).toBe(true)
      expect(evalPerm(build, "edit")).toBe("allow")
      expect(evalPerm(build, "bash")).toBe("allow")
    },
  })
})

test("plan agent denies edits except .openresearch/plans/*", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await Agent.get("plan")
      expect(plan).toBeDefined()
      // Wildcard is denied
      expect(evalPerm(plan, "edit")).toBe("deny")
      // But specific path is allowed
      expect(PermissionNext.evaluate("edit", ".openresearch/plans/foo.md", plan!.permission).action).toBe("allow")
    },
  })
})

test("explore agent denies edit and write", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(explore?.mode).toBe("subagent")
      expect(evalPerm(explore, "edit")).toBe("deny")
      expect(evalPerm(explore, "write")).toBe("deny")
      expect(evalPerm(explore, "todoread")).toBe("deny")
      expect(evalPerm(explore, "todowrite")).toBe("deny")
      expect(evalPerm(explore, "spawn_agent")).toBe("deny")
      expect(evalPerm(explore, "workflow")).toBe("deny")
    },
  })
})

test("explore agent asks for external directories and allows Truncate.GLOB", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeDefined()
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", explore!.permission).action).toBe("ask")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, explore!.permission).action).toBe("allow")
    },
  })
})

test("general agent denies todo tools", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const general = await Agent.get("general")
      expect(general).toBeDefined()
      expect(general?.mode).toBe("subagent")
      expect(general?.hidden).toBeUndefined()
      expect(evalPerm(general, "todoread")).toBe("deny")
      expect(evalPerm(general, "todowrite")).toBe("deny")
      expect(evalPerm(general, "spawn_agent")).toBe("deny")
      expect(evalPerm(general, "workflow")).toBe("deny")
    },
  })
})

test("resource preparation agent owns acquisition through verification", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const prepare = await Agent.get("experiment_resource_prepare")
      const old = await Agent.get("experiment_remote_download")

      expect(prepare).toBeDefined()
      expect(prepare?.mode).toBe("subagent")
      expect(prepare?.native).toBe(true)
      expect(evalPerm(prepare, "huggingface_search")).toBe("allow")
      expect(evalPerm(prepare, "modelscope_search")).toBe("allow")
      expect(evalPerm(prepare, "experiment_remote_task_start")).toBe("allow")
      expect(evalPerm(prepare, "project_runtime_resource_query")).toBe("allow")
      expect(evalPerm(prepare, "project_runtime_resource_upsert")).toBe("allow")
      expect(evalPerm(prepare, "read")).toBe("deny")
      expect(evalPerm(prepare, "project_runtime_server_query")).toBe("deny")

      expect(await Agent.get("project_runtime_resource_download")).toBeUndefined()
      expect(old).toBeUndefined()
    },
  })
})

test("research agent carries the shared Atom graph definition", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const research = await Agent.get("research")
      expect(evalPerm(research, "research_code_branch_query")).toBe("allow")
      expect(evalPerm(research, "workflow")).toBe("deny")
      expect(research?.prompt).toContain("## Atom model")
      expect(research?.prompt).toContain("`evaluated_by`")
      expect(research?.prompt).not.toContain("expectedHeadSha")
    },
  })
})

test("experiment agent owns the autonomous remote lifecycle", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const experiment = await Agent.get("experiment")

      expect(experiment?.prompt).toContain("Never use a workflow")
      expect(evalPerm(experiment, "workflow")).toBe("deny")
      expect(experiment?.prompt).toContain("experiment_execution_watch_update")
      expect(experiment?.prompt).toContain("listenForTerminal: true")
      expect(experiment?.prompt).toContain("Sync local code with `experiment_code_sync`")
      expect(experiment?.prompt).toContain('agent_type: "project_runtime_env_setup"')
      expect(experiment?.prompt).toContain("`experiment_commit`")
      expect(experiment?.prompt).toContain("`explore` for code inspection")
      expect(experiment?.prompt).toContain("`general` for focused implementation")
      expect(experiment?.prompt).toContain("Inspect changes returned by `general`")
      expect(experiment?.prompt).toContain("Do not rewrite the baseline trainer")
      expect(experiment?.prompt).toContain("exact returned `remoteCodePath`")
      expect(experiment?.prompt).toContain("Never spawn environment setup for unsynced code")
      expect(experiment?.prompt).toContain("Spawn at most one long-running child per turn")
      expect(experiment?.prompt).toContain("one related unresolved `resources` batch")
      expect(experiment?.prompt).toContain("exclusively owns inventory lookup")
      expect(experiment?.prompt).toContain("--git-common-dir")
      expect(experiment?.prompt).toContain("Aggressive Runtime Reuse")
      expect(experiment?.prompt).toContain("runtime_success")
      expect(experiment?.prompt).toContain("without SSH checks")
      expect(experiment?.prompt).toContain("Code, algorithm, syntax, and parameter errors do not invalidate")
      expect(experiment?.prompt).not.toContain("deploying_code")
      expect(evalPerm(experiment, "remote_terminal_start")).toBe("deny")
      expect(PermissionNext.evaluate("task", "experiment_plan", experiment!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("task", "explore", experiment!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("task", "general", experiment!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("spawn_agent", "project_runtime_env_setup", experiment!.permission).action).toBe(
        "allow",
      )
      expect(PermissionNext.evaluate("spawn_agent", "general", experiment!.permission).action).toBe("deny")
      expect(await Agent.get("experiment_deploy")).toBeUndefined()
      expect(await Agent.get("experiment_setup_env")).toBeUndefined()
      expect(await Agent.get("experiment_run")).toBeUndefined()
      expect(await Agent.get("experiment_summary")).toBeUndefined()
      expect(await Agent.get("experiment_success")).toBeUndefined()
    },
  })
})

test("experiment subagents keep focused permissions and contracts", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const plan = await Agent.get("experiment_plan")
      const env = await Agent.get("project_runtime_env_setup")
      const resource = await Agent.get("experiment_resource_prepare")
      const commit = await Agent.get("experiment_commit")

      expect(evalPerm(plan, "bash")).toBe("deny")
      expect(evalPerm(plan, "edit")).toBe("allow")
      expect(PermissionNext.disabled(["edit", "write", "apply_patch"], plan!.permission).size).toBe(0)
      expect(evalPerm(plan, "experiment_query")).toBe("allow")
      expect(evalPerm(plan, "experiment_remote_task_start")).toBe("deny")
      expect(plan?.prompt).toContain("whether code changes are required")
      expect(plan?.prompt).toContain("Runtime Inputs:")
      expect(plan?.prompt).not.toContain("Do not design baseline rewrites")
      expect(evalPerm(env, "experiment_query")).toBe("allow")
      expect(evalPerm(resource, "experiment_query")).toBe("allow")
      expect(evalPerm(commit, "experiment_query")).toBe("allow")
      expect(evalPerm(env, "question")).toBe("deny")
      expect(evalPerm(env, "read")).toBe("deny")
      expect(evalPerm(env, "glob")).toBe("deny")
      expect(evalPerm(env, "grep")).toBe("deny")
      expect(evalPerm(resource, "question")).toBe("deny")
      expect(evalPerm(commit, "remote_terminal_start")).toBe("deny")
      expect(env?.prompt).toContain("Run Prefix")
      expect(env?.prompt).toContain("code already synced")
      expect(env?.prompt).toContain("remoteCodePath")
      expect(env?.prompt).toContain("`pip install .` and `pip install -e .`")
      expect(env?.prompt).toContain("Preserve existing `spec.runtime_success`")
      expect(resource?.prompt).toContain("complete physical lifecycle")
      expect(resource?.prompt).toContain("must not be rechecked")
      expect(resource?.prompt).toContain("Preserve existing inventory metadata and `verify.runtime_success`")
      expect(resource?.prompt).toContain("listenForTerminal: true")
      expect(commit?.prompt).toContain("Never run `git add .`")
      expect(commit?.prompt).toContain("git rev-parse HEAD")
    },
  })
})

test("compaction agent denies all permissions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const compaction = await Agent.get("compaction")
      expect(compaction).toBeDefined()
      expect(compaction?.hidden).toBe(true)
      expect(evalPerm(compaction, "bash")).toBe("deny")
      expect(evalPerm(compaction, "edit")).toBe("deny")
      expect(evalPerm(compaction, "read")).toBe("deny")
    },
  })
})

test("custom agent from config creates new agent", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        my_custom_agent: {
          model: "openai/gpt-4",
          description: "My custom agent",
          temperature: 0.5,
          top_p: 0.9,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const custom = await Agent.get("my_custom_agent")
      expect(custom).toBeDefined()
      expect(custom?.model?.providerID).toBe("openai")
      expect(custom?.model?.modelID).toBe("gpt-4")
      expect(custom?.description).toBe("My custom agent")
      expect(custom?.temperature).toBe(0.5)
      expect(custom?.topP).toBe(0.9)
      expect(custom?.native).toBe(false)
      expect(custom?.mode).toBe("all")
    },
  })
})

test("custom agent config overrides native agent properties", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          model: "anthropic/claude-3",
          description: "Custom build agent",
          temperature: 0.7,
          color: "#FF0000",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(build?.model?.providerID).toBe("anthropic")
      expect(build?.model?.modelID).toBe("claude-3")
      expect(build?.description).toBe("Custom build agent")
      expect(build?.temperature).toBe(0.7)
      expect(build?.color).toBe("#FF0000")
      expect(build?.native).toBe(true)
    },
  })
})

test("agent disable removes agent from list", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore).toBeUndefined()
      const agents = await Agent.list()
      const names = agents.map((a) => a.name)
      expect(names).not.toContain("explore")
    },
  })
})

test("agent permission config merges with defaults", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            bash: {
              "rm -rf *": "deny",
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      // Specific pattern is denied
      expect(PermissionNext.evaluate("bash", "rm -rf *", build!.permission).action).toBe("deny")
      // Edit still allowed
      expect(evalPerm(build, "edit")).toBe("allow")
    },
  })
})

test("global permission config applies to all agents", async () => {
  await using tmp = await tmpdir({
    config: {
      permission: {
        bash: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build).toBeDefined()
      expect(evalPerm(build, "bash")).toBe("deny")
    },
  })
})

test("agent steps/maxSteps config sets steps property", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { steps: 50 },
        plan: { maxSteps: 100 },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      const plan = await Agent.get("plan")
      expect(build?.steps).toBe(50)
      expect(plan?.steps).toBe(100)
    },
  })
})

test("agent mode can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: { mode: "primary" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const explore = await Agent.get("explore")
      expect(explore?.mode).toBe("primary")
    },
  })
})

test("agent name can be overridden", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { name: "Builder" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.name).toBe("Builder")
    },
  })
})

test("agent prompt can be set from config", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { prompt: "Custom system prompt" },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.prompt).toBe("Custom system prompt")
    },
  })
})

test("unknown agent properties are placed into options", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          random_property: "hello",
          another_random: 123,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.options.random_property).toBe("hello")
      expect(build?.options.another_random).toBe(123)
    },
  })
})

test("agent options merge correctly", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          options: {
            custom_option: true,
            another_option: "value",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(build?.options.custom_option).toBe(true)
      expect(build?.options.another_option).toBe("value")
    },
  })
})

test("multiple custom agents can be defined", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        agent_a: {
          description: "Agent A",
          mode: "subagent",
        },
        agent_b: {
          description: "Agent B",
          mode: "primary",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agentA = await Agent.get("agent_a")
      const agentB = await Agent.get("agent_b")
      expect(agentA?.description).toBe("Agent A")
      expect(agentA?.mode).toBe("subagent")
      expect(agentB?.description).toBe("Agent B")
      expect(agentB?.mode).toBe("primary")
    },
  })
})

test("Agent.get returns undefined for non-existent agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const nonExistent = await Agent.get("does_not_exist")
      expect(nonExistent).toBeUndefined()
    },
  })
})

test("default permission includes doom_loop and external_directory as ask", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "doom_loop")).toBe("ask")
      expect(evalPerm(build, "external_directory")).toBe("ask")
    },
  })
})

test("webfetch is allowed by default", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "webfetch")).toBe("allow")
    },
  })
})

test("legacy tools config converts to permissions", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            bash: false,
            read: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "bash")).toBe("deny")
      expect(evalPerm(build, "read")).toBe("deny")
    },
  })
})

test("legacy tools config maps write/edit/patch/multiedit to edit permission", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          tools: {
            write: false,
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(evalPerm(build, "edit")).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory globally", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: "deny",
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("Truncate.GLOB is allowed even when user denies external_directory per-agent", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: {
          permission: {
            external_directory: "deny",
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("allow")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", "/some/other/path", build!.permission).action).toBe("deny")
    },
  })
})

test("explicit Truncate.GLOB deny is respected", async () => {
  const { Truncate } = await import("../../src/tool/truncation")
  await using tmp = await tmpdir({
    config: {
      permission: {
        external_directory: {
          "*": "deny",
          [Truncate.GLOB]: "deny",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")
      expect(PermissionNext.evaluate("external_directory", Truncate.GLOB, build!.permission).action).toBe("deny")
      expect(PermissionNext.evaluate("external_directory", Truncate.DIR, build!.permission).action).toBe("deny")
    },
  })
})

test("skill directories are allowed for external_directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".openresearch", "skill", "perm-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: perm-skill
description: Permission skill.
---

# Permission Skill
`,
      )
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const skillDir = path.join(tmp.path, ".openresearch", "skill", "perm-skill")
        const target = path.join(skillDir, "reference", "notes.md")
        expect(PermissionNext.evaluate("external_directory", target, build!.permission).action).toBe("allow")
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("defaultAgent returns build when no default_agent config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("build")
    },
  })
})

test("defaultAgent respects default_agent config set to plan", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "plan",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent respects default_agent config set to custom agent with mode all", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "my_custom",
      agent: {
        my_custom: {
          description: "My custom agent",
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      expect(agent).toBe("my_custom")
    },
  })
})

test("defaultAgent throws when default_agent points to subagent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "explore",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "explore" is a subagent')
    },
  })
})

test("defaultAgent throws when default_agent points to hidden agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "compaction",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "compaction" is hidden')
    },
  })
})

test("defaultAgent throws when default_agent points to non-existent agent", async () => {
  await using tmp = await tmpdir({
    config: {
      default_agent: "does_not_exist",
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Agent.defaultAgent()).rejects.toThrow('default agent "does_not_exist" not found')
    },
  })
})

test("defaultAgent returns plan when build is disabled and default_agent not set", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.defaultAgent()
      // build is disabled, so it should return plan (next primary agent)
      expect(agent).toBe("plan")
    },
  })
})

test("defaultAgent throws when all primary agents are disabled", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        build: { disable: true },
        plan: { disable: true },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // build and plan are disabled, no primary-capable agents remain
      await expect(Agent.defaultAgent()).rejects.toThrow("no primary visible agent found")
    },
  })
})
