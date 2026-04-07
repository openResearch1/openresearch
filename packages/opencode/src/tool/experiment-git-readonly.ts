import z from "zod"
import { Tool } from "./tool"
import { Database, eq } from "../storage/db"
import { ExperimentTable } from "../research/research.sql"
import { Research } from "../research/research"
import { git } from "../util/git"

const allow = new Set([
  "show",
  "log",
  "diff",
  "rev-parse",
  "branch",
  "status",
  "ls-tree",
  "ls-files",
  "cat-file",
  "blame",
  "merge-base",
])

const deny = new Set([
  "checkout",
  "switch",
  "merge",
  "rebase",
  "reset",
  "clean",
  "commit",
  "push",
  "pull",
  "fetch",
  "stash",
  "cherry-pick",
  "revert",
  "tag",
  "add",
  "rm",
  "mv",
  "restore",
  "am",
  "apply",
  "bisect",
  "worktree",
  "submodule",
])

const branch_deny = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "--delete",
  "--move",
  "--copy",
  "--create-reflog",
  "--edit-description",
  "--set-upstream-to",
  "--unset-upstream",
  "--track",
  "--no-track",
  "--force",
])

function check(args: string[]) {
  if (args.length === 0) return "At least one git subcommand is required."
  const sub = args[0]
  if (sub.startsWith("-")) return "Pass a git subcommand as the first argument. Global git flags are not allowed."
  if (deny.has(sub)) return `git ${sub} is not allowed in experiment_git_readonly.`
  if (!allow.has(sub)) return `git ${sub} is not supported in experiment_git_readonly.`

  if (sub !== "branch") return null
  for (const arg of args.slice(1)) {
    if (branch_deny.has(arg)) return `git branch ${arg} is not allowed in experiment_git_readonly.`
    if (!arg.startsWith("-")) return "git branch only supports readonly listing flags in experiment_git_readonly."
  }
  return null
}

export const ExperimentGitReadonlyTool = Tool.define("experiment_git_readonly", {
  description:
    "Run a readonly git command inside the code repository for a specific experiment. " +
    "This tool resolves the experiment's code_path automatically and blocks branch switching or other mutating git operations.",
  parameters: z.object({
    expId: z.string().describe("The experiment ID whose code repository should be inspected"),
    args: z.array(z.string()).min(1).describe("Readonly git arguments, excluding the leading 'git'"),
  }),
  async execute(params, ctx) {
    const researchProjectId = await Research.getResearchProjectId(ctx.sessionID)
    if (!researchProjectId) {
      return {
        title: "Failed",
        output: "Current session is not associated with any research project.",
        metadata: { exitCode: 1, codePath: undefined as string | undefined, branch: undefined as string | undefined },
      }
    }

    const exp = Database.use((db) =>
      db.select().from(ExperimentTable).where(eq(ExperimentTable.exp_id, params.expId)).get(),
    )
    if (!exp || exp.research_project_id !== researchProjectId) {
      return {
        title: "Not found",
        output: `Experiment not found: ${params.expId}`,
        metadata: { exitCode: 1, codePath: undefined as string | undefined, branch: undefined as string | undefined },
      }
    }

    const err = check(params.args)
    if (err) {
      return {
        title: "Blocked",
        output: err,
        metadata: { exitCode: 1, codePath: exp.code_path, branch: undefined as string | undefined },
      }
    }

    const root = await git(["rev-parse", "--show-toplevel"], { cwd: exp.code_path })
    if (root.exitCode !== 0) {
      return {
        title: "Failed",
        output: `code_path is not a usable git repository: ${exp.code_path}\n${root.stderr.toString().trim() || root.text().trim()}`,
        metadata: { exitCode: root.exitCode, codePath: exp.code_path, branch: undefined as string | undefined },
      }
    }

    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: exp.code_path })
    const branch = head.exitCode === 0 ? head.text().trim() : undefined
    const res = await git(params.args, { cwd: exp.code_path })
    const stdout = res.text().trim()
    const stderr = res.stderr.toString().trim()
    const body = [stdout, stderr].filter(Boolean).join("\n\n") || "(no output)"

    return {
      title: res.exitCode === 0 ? `Git: ${params.args[0]}` : `Git failed: ${params.args[0]}`,
      output: [
        `Experiment ID: ${exp.exp_id}`,
        `Code Path: ${exp.code_path}`,
        `Current Branch: ${branch ?? "unknown"}`,
        `Command: git ${params.args.join(" ")}`,
        `Exit Code: ${res.exitCode}`,
        "",
        body,
      ].join("\n"),
      metadata: { exitCode: res.exitCode, codePath: exp.code_path, branch },
    }
  },
})
