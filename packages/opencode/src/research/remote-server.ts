import os from "node:os"
import path from "node:path"
import z from "zod"

const Shared = {
  resource_root: z.string().optional(),
  wandb_api_key: z.string().optional(),
  wandb_project_name: z.string().optional(),
}

export const RemoteServerDirectSchema = z.object({
  mode: z.literal("direct"),
  address: z.string(),
  port: z.number(),
  user: z.string(),
  password: z.string().optional(),
  ...Shared,
})

export const RemoteServerSshConfigSchema = z.object({
  mode: z.literal("ssh_config"),
  host_alias: z.string(),
  ssh_config_path: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  ...Shared,
})

export const RemoteServerLegacySchema = z.object({
  address: z.string(),
  port: z.number(),
  user: z.string(),
  password: z.string().optional(),
  ...Shared,
})

export const RemoteServerConfigSchema = z.union([RemoteServerDirectSchema, RemoteServerSshConfigSchema])
export const RemoteServerInputSchema = z.union([
  RemoteServerDirectSchema,
  RemoteServerSshConfigSchema,
  RemoteServerLegacySchema,
])

export type RemoteServerConfig = z.infer<typeof RemoteServerConfigSchema>

export function normalizeRemoteServerConfig(input: z.input<typeof RemoteServerInputSchema>): RemoteServerConfig {
  if ("mode" in input) return input
  return {
    mode: "direct",
    address: input.address,
    port: input.port,
    user: input.user,
    password: input.password,
    resource_root: input.resource_root,
    wandb_api_key: input.wandb_api_key,
    wandb_project_name: input.wandb_project_name,
  }
}

export function resolveSshConfigPath(input?: string) {
  if (!input) return path.join(os.homedir(), ".ssh", "config")
  if (input === "~") return os.homedir()
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  return input
}

export function remoteServerLabel(input: RemoteServerConfig) {
  if (input.mode === "ssh_config") return input.host_alias
  return `${input.user}@${input.address}:${input.port}`
}
