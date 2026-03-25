import { defineConfig } from "drizzle-kit"
import path from "path"
import { fileURLToPath } from "url"
import module from "module"

// Register path aliases so drizzle-kit can resolve @/* imports
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(__dirname, "src")
const require = module.createRequire(import.meta.url)
// @ts-ignore - Node internal API
const originalResolve = module.Module._resolveFilename
// @ts-ignore
module.Module._resolveFilename = function (request: string, parent: any, ...args: any[]) {
  if (request.startsWith("@/")) {
    request = path.join(srcDir, request.slice(2))
  } else if (request.startsWith("@tui/")) {
    request = path.join(srcDir, "cli/cmd/tui", request.slice(5))
  }
  return originalResolve.call(this, request, parent, ...args)
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: "/home/thdxr/.local/share/opencode/opencode.db",
  },
})
