import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions, assertPassword, addresses } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    assertPassword(opts)
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    if (opts.hostname === "0.0.0.0") {
      for (const ip of addresses()) {
        console.log(`opencode remote listening on http://${ip}:${server.port}/remote`)
      }
    } else {
      console.log(`opencode remote listening on http://${server.hostname}:${server.port}/remote`)
    }
    if (opts.mdns) {
      console.log(`opencode remote mDNS listening on http://${opts.mdnsDomain}:${server.port}/remote`)
    }

    await new Promise(() => {})
    await server.stop()
  },
})
