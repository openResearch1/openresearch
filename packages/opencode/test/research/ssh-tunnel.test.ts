import { describe, expect, test } from "bun:test"
import { normalizeRemoteServerConfig } from "../../src/research/remote-server"
import { buildTunnelArgs, tunnelEnv } from "../../src/research/ssh-tunnel"

describe("research.ssh-tunnel", () => {
  test("normalizes legacy servers to direct networking", () => {
    expect(
      normalizeRemoteServerConfig({
        address: "10.0.0.1",
        port: 22,
        user: "root",
      }),
    ).toEqual({
      mode: "direct",
      address: "10.0.0.1",
      port: 22,
      user: "root",
      password: undefined,
      resource_root: undefined,
      wandb_api_key: undefined,
      wandb_project_name: undefined,
      network: {
        mode: "direct",
      },
    })
  })

  test("builds ssh config tunnel launch args", () => {
    expect(
      buildTunnelArgs({
        mode: "ssh_config",
        host_alias: "gpu-box",
        ssh_config_path: "~/.ssh/config",
        user: "root",
        network: {
          mode: "tunnel",
          local_proxy: "127.0.0.1:7890",
          remote_port: 8890,
        },
      }),
    ).toEqual({
      cmd: "ssh",
      args: [
        "-F",
        expect.stringContaining(".ssh/config"),
        "-l",
        "root",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-N",
        "-T",
        "-R",
        "127.0.0.1:8890:127.0.0.1:7890",
        "gpu-box",
      ],
    })
  })

  test("returns proxy env for tunnel networking only", () => {
    expect(
      tunnelEnv({
        mode: "direct",
        address: "10.0.0.1",
        port: 22,
        user: "root",
        network: {
          mode: "direct",
        },
      }),
    ).toBeUndefined()

    expect(
      tunnelEnv({
        mode: "direct",
        address: "10.0.0.1",
        port: 22,
        user: "root",
        network: {
          mode: "tunnel",
          local_proxy: "http://127.0.0.1:7890",
          remote_port: 18890,
          no_proxy: "localhost,127.0.0.1,.svc",
        },
      }),
    ).toEqual({
      http_proxy: "http://127.0.0.1:18890",
      https_proxy: "http://127.0.0.1:18890",
      no_proxy: "localhost,127.0.0.1,.svc",
    })
  })
})
