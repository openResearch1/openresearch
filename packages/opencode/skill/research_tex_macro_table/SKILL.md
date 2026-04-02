---
name: research_tex_macro_table
description: Build or update a macro table for a LaTeX research article by reading math-related macro definitions and writing a normalized article macro table with article_macro_edit.
---

# Research TeX Macro Table

Use this skill when a research article is stored as a `latex_directory` and downstream work needs reliable math notation normalization.

## Goal

Produce an article-level `macro_table.md` that records the article's math-relevant private macros and their normalized interpretations.

The macro table is the source of truth for later background, goal, and atom generation. Do not skip it for LaTeX articles.

## Workflow

1. Use `article_query` to fetch the target article metadata.
2. Confirm the article kind is `latex_directory`.
3. Inspect the article directory with `read`, and use `glob` / `grep` only as needed to find:
   - main `.tex` files
   - preamble files
   - `macros.tex`, `defs.tex`, `notation.tex`, `commands.tex`, or similarly named files
   - files containing `\newcommand`, `\renewcommand`, `\def`, or `\DeclareMathOperator`
4. Read only the files needed to recover math-related macro definitions.
5. Build a macro table that includes:
   - article metadata
   - resolved math-relevant macros
   - unresolved or conservatively interpreted macros
6. Write the result with `article_macro_edit` using `oldString=""` when creating a new file.
7. If a macro table already exists, read it first and then update it with `article_macro_edit`.

## Scope rules

Collect only macros that affect mathematical meaning, including:
- math operators
- notation aliases
- argument-taking math macros
- symbols, sets, operators, objectives, losses, distributions, or theorem notation

Ignore pure presentation macros unless they change mathematical meaning:
- spacing
- colors
- typography
- theorem environment styling
- page layout

## Output format

Write markdown using this structure:

```md
# Macro Table

## Article
- article_id: ...
- path: ...

## Resolved Macros

### \foo
- kind: newcommand
- arity: 1
- original: `...`
- normalized: `...`
- notes: ...

## Unresolved Macros

### \bar
- original: `...`
- reason: ...
- conservative_use: ...
```

## Requirements

- Preserve mathematical meaning conservatively.
- Do not guess macro expansions you cannot justify from the source.
- If a macro is ambiguous, place it under `Unresolved Macros`.
- Prefer normalized standalone LaTeX or readable mathematical prose that does not depend on the original preamble.
- Keep the table focused and inspectable; do not mix in paper summary text.
