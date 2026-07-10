import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions, assertPassword, addresses } from "../network"
import { Flag } from "../../flag/flag"
import open from "open"

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start opencode server and open web interface",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    assertPassword(opts)
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + "OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = Server.listen(opts)
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = addresses()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          const url = `http://${ip}:${server.port}`
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            url,
          )
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Phone remote:      ",
            UI.Style.TEXT_NORMAL,
            `${url}/remote`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS remote:       ",
          UI.Style.TEXT_NORMAL,
          `http://${opts.mdnsDomain}:${server.port}/remote`,
        )
      }

      // Open localhost in browser
      open(localhostUrl.toString()).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Phone remote:     ", UI.Style.TEXT_NORMAL, `${displayUrl}remote`)
      open(displayUrl).catch(() => {})
    }

    await new Promise(() => {})
    await server.stop()
  },
})
