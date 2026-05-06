import fs from "fs/promises"
import path from "path"

export async function isArticleDirectory(dir: string) {
  const items = await fs.readdir(dir, { withFileTypes: true })
  return items.some((item) => !item.isDirectory() && item.name.endsWith(".tex"))
}

export async function listArticleSources(dir: string) {
  const items = await fs.readdir(dir, { withFileTypes: true })
  const out: string[] = []

  for (const item of items) {
    const file = path.join(dir, item.name)
    if (!item.isDirectory()) {
      if (path.extname(item.name).toLowerCase() === ".pdf") out.push(file)
      continue
    }
    if (await isArticleDirectory(file)) out.push(file)
  }

  return out.sort((left, right) => left.localeCompare(right))
}

export function articleTitle(file: string) {
  const base = path.basename(file).replace(/\.[^.]+$/, "")
  const parts = base.split(" - ")
  if (parts.length >= 3) return parts.slice(2).join(" - ")
  return base
}
