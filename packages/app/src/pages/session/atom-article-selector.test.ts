import { expect, test } from "bun:test"

import { sync } from "./atom-article-selector"

test("restores the linked article after options load", () => {
  const select = document.createElement("select")
  const empty = document.createElement("option")
  empty.value = ""
  empty.textContent = "No linked article"
  select.append(empty)

  sync(select, "article-1")
  expect(select.value).toBe("")

  const article = document.createElement("option")
  article.value = "article-1"
  article.textContent = "Paper"
  select.append(article)
  sync(select, "article-1")
  expect(select.value).toBe("article-1")

  sync(select, "")
  expect(select.value).toBe("")
})
