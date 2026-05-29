import z from "zod"

import { Pty } from "@/pty"
import { quote } from "@/research/ssh-tunnel"
import { Tool } from "./tool"

const id = z.string().describe("Remote terminal PTY ID returned by remote_terminal_start or remote_terminal_list.")
const LIMIT = 20000

function remote(ptyID: string) {
  const info = Pty.get(ptyID)
  if (!info) throw new Error(`remote terminal not found: ${ptyID}`)
  if (info.type !== "remote") throw new Error(`PTY is not a remote terminal: ${ptyID}`)
  return info
}

function output(ptyID: string, cursor?: number, limit?: number) {
  const result = Pty.read(ptyID, { cursor, limit: limit ?? LIMIT })
  if (!result) throw new Error(`remote terminal not found: ${ptyID}`)
  return result
}

function summary(info: Pty.Info) {
  return {
    ptyID: info.id,
    title: info.title,
    status: info.status,
    remoteServerId: info.remote_server_id,
    remoteLabel: info.remote_label,
  }
}

export const RemoteTerminalStartTool = Tool.define("remote_terminal_start", {
  description:
    "Start a remote interactive terminal over SSH. Use this for long-running remote work that the user should be able to watch and that the agent may interact with.",
  parameters: z.object({
    serverId: z.string().describe("Configured remote server ID."),
    title: z.string().optional().describe("Optional terminal tab title."),
    cwd: z.string().optional().describe("Optional remote directory to cd into after the SSH terminal starts."),
    command: z.string().optional().describe("Optional initial command to run in the remote terminal."),
  }),
  async execute(params) {
    const info = await Pty.createRemote({ serverId: params.serverId, title: params.title })
    if (params.cwd) Pty.write(info.id, `cd ${quote(params.cwd)}\r`)
    if (params.command) Pty.write(info.id, `${params.command}\r`)
    const result = output(info.id)

    return {
      title: `Remote terminal: ${info.title}`,
      output: [
        `PTY ID: ${info.id}`,
        `Title: ${info.title}`,
        `Status: ${info.status}`,
        `Server: ${info.remote_label ?? info.remote_server_id ?? "-"}`,
        `Cursor: ${result.cursor}`,
      ].join("\n"),
      metadata: {
        ...summary(info),
        cursor: result.cursor,
        previousCursor: result.previousCursor,
        output: result.output,
        truncated: result.truncated,
      },
    }
  },
})

export const RemoteTerminalWriteTool = Tool.define("remote_terminal_write", {
  description: "Write input into a running remote terminal. Set enter=true to submit the input as a command.",
  parameters: z.object({
    ptyID: id,
    input: z.string().describe("Text to write to the remote terminal."),
    enter: z.boolean().optional().default(false).describe("Append Enter after the input."),
  }),
  async execute(params) {
    const info = remote(params.ptyID)
    Pty.write(params.ptyID, params.enter ? `${params.input}\r` : params.input)
    const result = output(params.ptyID)

    return {
      title: `Remote terminal: ${info.title}`,
      output: [`PTY ID: ${info.id}`, `Wrote: ${params.enter ? "input + enter" : "input"}`, `Cursor: ${result.cursor}`].join(
        "\n",
      ),
      metadata: {
        ...summary(info),
        cursor: result.cursor,
        previousCursor: result.previousCursor,
        truncated: result.truncated,
      },
    }
  },
})

export const RemoteTerminalReadTool = Tool.define("remote_terminal_read", {
  description:
    "Read output from a remote terminal. Pass the previous cursor to receive only new terminal output since that point.",
  parameters: z.object({
    ptyID: id,
    cursor: z.number().optional().describe("Previous cursor returned by remote_terminal_start/read/wait."),
    limit: z.number().positive().optional().describe("Maximum number of characters to return from the terminal output."),
  }),
  async execute(params) {
    const info = remote(params.ptyID)
    const result = output(params.ptyID, params.cursor, params.limit)

    return {
      title: `Remote terminal: ${info.title}`,
      output: result.output || "(no new output)",
      metadata: {
        ...summary(info),
        cursor: result.cursor,
        previousCursor: result.previousCursor,
        output: result.output,
        truncated: result.truncated,
      },
    }
  },
})

export const RemoteTerminalWaitTool = Tool.define("remote_terminal_wait", {
  description:
    "Wait for a remote terminal to produce new output, match a string or regex, exit, or time out. Use this instead of frequent polling during long-running remote work.",
  parameters: z.object({
    ptyID: id,
    cursor: z.number().optional().describe("Previous cursor returned by remote_terminal_start/read/wait."),
    pattern: z.string().optional().describe("String or regex pattern to wait for in new terminal output."),
    regex: z.boolean().optional().default(false).describe("Treat pattern as a JavaScript regular expression."),
    timeoutMs: z.number().positive().optional().describe("Maximum wait time in milliseconds. Defaults to 30000."),
    limit: z.number().positive().optional().describe("Maximum number of characters to return from the terminal output."),
  }),
  async execute(params, ctx) {
    const info = remote(params.ptyID)
    await ctx.metadata({
      title: `Waiting: ${info.title}`,
      metadata: { ...summary(info), phase: "waiting", cursor: params.cursor, pattern: params.pattern },
    })
    const result = await Pty.wait({
      id: params.ptyID,
      cursor: params.cursor,
      pattern: params.pattern,
      regex: params.regex,
      timeoutMs: params.timeoutMs,
      signal: ctx.abort,
      limit: params.limit ?? LIMIT,
    })
    if (!result) throw new Error(`remote terminal not found: ${params.ptyID}`)

    return {
      title: `Remote terminal: ${info.title}`,
      output: result.output || "(no new output before timeout)",
      metadata: {
        ...summary(result.info),
        cursor: result.cursor,
        previousCursor: result.previousCursor,
        output: result.output,
        truncated: result.truncated,
        matched: params.pattern ? (params.regex ? new RegExp(params.pattern).test(result.output) : result.output.includes(params.pattern)) : result.output.length > 0,
      },
    }
  },
})

export const RemoteTerminalListTool = Tool.define("remote_terminal_list", {
  description: "List active remote terminals so the agent can choose a ptyID for reading or writing.",
  parameters: z.object({
    includeLocal: z.boolean().optional().default(false).describe("Include local PTY sessions in the list."),
  }),
  async execute(params) {
    const sessions = Pty.list().filter((info) => params.includeLocal || info.type === "remote")

    return {
      title: `${sessions.length} terminal(s)`,
      output: sessions.length
        ? sessions
            .map((info) =>
              [
                `PTY ID: ${info.id}`,
                `Title: ${info.title}`,
                `Status: ${info.status}`,
                `Type: ${info.type ?? "local"}`,
                info.remote_label ? `Server: ${info.remote_label}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n")
        : "No active remote terminals.",
      metadata: { terminals: sessions.map(summary) },
    }
  },
})

export const RemoteTerminalStopTool = Tool.define("remote_terminal_stop", {
  description: "Stop and remove a remote terminal.",
  parameters: z.object({
    ptyID: id,
  }),
  async execute(params) {
    const info = remote(params.ptyID)
    await Pty.remove(params.ptyID)

    return {
      title: `Stopped remote terminal: ${info.title}`,
      output: `Stopped PTY ID: ${info.id}`,
      metadata: { ...summary(info), stopped: true },
    }
  },
})
