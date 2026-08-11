import fs from "node:fs/promises"

import { and, Database, eq } from "@/storage/db"
import { git } from "@/util/git"

import { ExperimentTable } from "./research.sql"
import { ExperimentExecutionWatch } from "./experiment-execution-watch"

export namespace CodeBranch {
  export async function list(dir: string) {
    const top = await git(["rev-parse", "--show-toplevel"], { cwd: dir })
    if (top.exitCode !== 0) throw new Error(`not a git repository: ${dir}`)

    const root = await fs.realpath(top.text().trim())
    const result = await git(
      [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(subject)%00%(committerdate:iso-strict)%00%(HEAD)",
        "refs/heads",
      ],
      { cwd: root },
    )
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "failed to list git branches")

    const rows = result
      .text()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, name, headSha, subject, committedAt, head] = line.split("\0")
        return {
          branch: name,
          ref,
          headSha,
          subject,
          committedAt,
          current: head === "*",
          default: false,
          displayName: name,
          experimentId: null as string | null,
          experimentName: null as string | null,
          experimentStatus: null as string | null,
        }
      })
    const current = rows.find((row) => row.current)?.branch ?? null
    const base = rows.find((row) => row.branch === "main") ?? rows.find((row) => row.branch === "master")
    const fallback = base ?? rows.find((row) => row.current)
    if (fallback) fallback.default = true

    return {
      codeRoot: root,
      currentBranch: current,
      defaultBranch: fallback?.branch ?? null,
      branches: rows,
    }
  }

  export function experiments(info: Awaited<ReturnType<typeof list>>, researchProjectId: string) {
    const rows = Database.use((db) =>
      db
        .select()
        .from(ExperimentTable)
        .where(
          and(
            eq(ExperimentTable.research_project_id, researchProjectId),
            eq(ExperimentTable.kind, "experiment"),
          ),
        )
        .all(),
    )
    const map = new Map(rows.filter((row) => row.exp_branch_name).map((row) => [row.exp_branch_name!, row]))
    return {
      ...info,
      branches: info.branches.map((branch) => {
        const exp = map.get(branch.branch)
        if (!exp) return branch
        return {
          ...branch,
          displayName: exp.exp_name,
          experimentId: exp.exp_id,
          experimentName: exp.exp_name,
          experimentStatus: ExperimentExecutionWatch.resolve(exp.exp_id, exp.status),
        }
      }),
    }
  }

  export async function resolve(dir: string, branch: string) {
    const check = await git(["check-ref-format", "--branch", branch], { cwd: dir })
    if (check.exitCode !== 0) throw new Error(`invalid local branch: ${branch}`)
    const result = await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: dir })
    if (result.exitCode !== 0) throw new Error(`local branch not found: ${branch}`)
    return result.text().trim()
  }
}
