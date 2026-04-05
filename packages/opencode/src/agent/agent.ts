import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_RESEARCH_PROJECT_INIT from "./prompt/research_project_init.txt"
import PROMPT_EXPERIMENT from "./prompt/experiment.txt"
import PROMPT_EXPERIMENT_COMMIT from "./prompt/experiment_commit.txt"
import PROMPT_EXPERIMENT_PLAN from "./prompt/experiment_plan.txt"
import PROMPT_EXPERIMENT_LOCAL_DOWNLOAD from "./prompt/experiment_local_download.txt"
import PROMPT_EXPERIMENT_REMOTE_DOWNLOAD from "./prompt/experiment_remote_download.txt"
import PROMPT_EXPERIMENT_SYNC_RESOURCE from "./prompt/experiment_sync_resource.txt"
import PROMPT_EXPERIMENT_DEPLOY from "./prompt/experiment_deploy.txt"
import PROMPT_EXPERIMENT_SETUP_ENV from "./prompt/experiment_setup_env.txt"
import PROMPT_EXPERIMENT_RUN from "./prompt/experiment_run.txt"
import PROMPT_EXPERIMENT_SUMMARY from "./prompt/experiment_summary.txt"
import PROMPT_EXPERIMENT_SUCCESS from "./prompt/experiment_success.txt"
import PROMPT_EVIDENCE_ASSESSMENT from "./prompt/evidence_assessment.txt"
import PROMPT_ATOM_FORMULA_CLEANUP from "./prompt/atom_formula_cleanup.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: PermissionNext.Ruleset,
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  const state = Instance.state(async () => {
    const cfg = await Config.get()

    const skillDirs = await Skill.dirs()
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
    const defaults = PermissionNext.fromConfig({
      "*": "allow",
      doom_loop: "ask",
      external_directory: {
        "*": "ask",
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
      research_doc_edit: "ask",
      question: "deny",
      plan_enter: "deny",
      plan_exit: "deny",
      // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
      read: {
        "*": "allow",
        "*.env": "ask",
        "*.env.*": "ask",
        "*.env.example": "allow",
      },
    })
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    const result: Record<string, Info> = {
      build: {
        name: "build",
        description: "General-purpose coding agent. Executes tools based on configured permissions.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      experiment: {
        name: "experiment",
        description:
          "Experiment execution agent. Reads the experiment plan and implements code changes strictly within the experiment's code_path.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
          }),
          user,
        ),
        prompt: PROMPT_EXPERIMENT,
        mode: "primary",
        native: true,
      },
      experiment_plan: {
        name: "experiment_plan",
        description:
          "Experiment plan generation agent. Analyzes the atom's claim, evidence, related atoms, and codebase to design a detailed experiment plan.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
          }),
          user,
        ),
        prompt: PROMPT_EXPERIMENT_PLAN,
        mode: "subagent",
        native: true,
      },
      experiment_deploy: {
        name: "experiment_deploy",
        description: "Experiment deploy agent. Syncs code to a remote server.",
        options: {},
        permission: PermissionNext.merge(defaults, PermissionNext.fromConfig({}), user),
        prompt: PROMPT_EXPERIMENT_DEPLOY,
        mode: "subagent",
        native: true,
      },
      experiment_local_download: {
        name: "experiment_local_download",
        description:
          "Experiment local download agent. Prepares datasets or artifacts locally in a reusable download-only environment.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            bash: "allow",
            read: "allow",
            question: "allow",
            huggingface_search: "allow",
            modelscope_search: "allow",
            experiment_resource_job_start: "allow",
            experiment_local_download_watch_init: "allow",
            experiment_local_download_watch_update: "allow",
            experiment_local_download_watch_refresh: "allow",
          }),
          user,
        ),
        prompt: PROMPT_EXPERIMENT_LOCAL_DOWNLOAD,
        mode: "subagent",
        native: true,
      },
      experiment_remote_download: {
        name: "experiment_remote_download",
        description:
          "Experiment remote download agent. Downloads resources directly on the remote server and verifies the final remote paths.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            ssh: "allow",
            read: "allow",
            question: "allow",
          }),
          user,
        ),
        prompt: PROMPT_EXPERIMENT_REMOTE_DOWNLOAD,
        mode: "subagent",
        native: true,
      },
      experiment_sync_resource: {
        name: "experiment_sync_resource",
        description:
          "Experiment resource sync agent. Syncs locally prepared resources to the remote server and verifies the final paths.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            bash: "allow",
            ssh: "allow",
            read: "allow",
            question: "allow",
            experiment_resource_job_start: "allow",
          }),
          user,
        ),
        prompt: PROMPT_EXPERIMENT_SYNC_RESOURCE,
        mode: "subagent",
        native: true,
      },
      experiment_setup_env: {
        name: "experiment_setup_env",
        description:
          "Experiment setup environment agent. Checks existing conda environments on the remote server, reuses or creates one as needed, and installs dependencies.",
        options: {},
        permission: PermissionNext.merge(defaults, PermissionNext.fromConfig({}), user),
        prompt: PROMPT_EXPERIMENT_SETUP_ENV,
        mode: "subagent",
        native: true,
      },
      experiment_run: {
        name: "experiment_run",
        description:
          "Experiment run agent. Launches the experiment on a remote server via nohup and monitors its startup.",
        options: {},
        permission: PermissionNext.merge(defaults, PermissionNext.fromConfig({}), user),
        prompt: PROMPT_EXPERIMENT_RUN,
        mode: "subagent",
        native: true,
      },
      research: {
        name: "research",
        description:
          "The primary OpenResearch agent. Maintains research state as an evolving graph of claim-evidence atoms, relations, plans, and research documents.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_enter: "allow",
            bash: "ask",
            edit: {
              "*": "deny",
              "*.md": "allow",
              "**/*.md": "allow",
            },
          }),
          user,
        ),
        prompt: PROMPT_RESEARCH,
        mode: "primary",
        native: true,
      },
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",
              [path.join(".openresearch", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            grep: "allow",
            glob: "allow",
            list: "allow",
            bash: "allow",
            webfetch: "allow",
            websearch: "allow",
            codesearch: "allow",
            read: "allow",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        options: {},
      },
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
      research_project_init: {
        name: "research_project_init",
        description:
          "Initialize a research project by auto-generating background/goal documents and building an atom network from articles.",
        prompt: PROMPT_RESEARCH_PROJECT_INIT,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            research_info: "allow",
            article_query: "allow",
            research_background_edit: "allow",
            research_goal_edit: "allow",
            research_macro_edit: "allow",
            atom_create: "allow",
            atom_query: "allow",
            atom_batch_create: "allow",
            atom_delete: "allow",
            atom_relation_query: "allow",
            atom_relation_create: "allow",
            atom_relation_delete: "allow",
            question: "allow",
            task: {
              atom_formula_cleanup: "allow",
            },
            read: "allow",
            glob: "allow",
            grep: "allow",
            edit: "allow",
            write: "allow",
            apply_patch: "allow",
            research_doc_edit: "ask",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      experiment_commit: {
        name: "experiment_commit",
        description:
          "Summarize code changes in the experiment's code_path and create a structured git commit with change details and stats.",
        prompt: PROMPT_EXPERIMENT_COMMIT,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            bash: "allow",
            read: "allow",
            glob: "allow",
            grep: "allow",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      experiment_summary: {
        name: "experiment_summary",
        description:
          "Summarize completed experiment results for an atom and write the evidence to evidence.md. Reads experiment watchers, W&B metrics, and synthesizes findings.",
        prompt: PROMPT_EXPERIMENT_SUMMARY,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            atom_query: "allow",
            experiment_query: "allow",
            read: "allow",
            write: "allow",
            edit: "allow",
            apply_patch: "allow",
            glob: "allow",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      experiment_success: {
        name: "experiment_success",
        description:
          "Summarize the actual runtime setup of a successful experiment run and write reusable success notes under openresearch/successful.",
        prompt: PROMPT_EXPERIMENT_SUCCESS,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            atom_query: "allow",
            experiment_query: "allow",
            read: "allow",
            write: "allow",
            edit: "allow",
            apply_patch: "allow",
            glob: "allow",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      evidence_assessment: {
        name: "evidence_assessment",
        description:
          "Assess whether an atom's evidence is sufficient to support its claim. Reads claim.md and evidence.md, writes assessment to evidence_assessment.md.",
        prompt: PROMPT_EVIDENCE_ASSESSMENT,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            atom_query: "allow",
            atom_status_update: "allow",
            read: "allow",
            write: "allow",
            edit: "allow",
            apply_patch: "allow",
            question: "allow",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
      atom_formula_cleanup: {
        name: "atom_formula_cleanup",
        description:
          "Inspect one atom's claim.md and evidence.md, identify garbled or unresolved formulas, and repair only those atom-local markdown files.",
        prompt: PROMPT_ATOM_FORMULA_CLEANUP,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
            read: "allow",
            write: "allow",
            edit: "allow",
            apply_patch: "allow",
            question: "allow",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },
    }

    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }

    // Ensure Truncate.GLOB is allowed unless explicitly configured
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "research"), "desc"]),
    )
  }

  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    const result = await generateObject(params)
    return result.object
  }
}
