---
name: thermos
description: "Launch both thermo-nuclear review subagents in parallel, then synthesize their findings. Use for thermos, double thermo review, or combined bug/security and code-quality branch audits."
disable-model-invocation: true
---

# Thermos

Run the two thermo review passes as background subagents in parallel, then synthesize their results into one deduplicated verdict.

## Workflow

1. Determine the review scope from the user request, PR, current branch, or relevant changed files.
2. Gather the diff and any file/context excerpts the reviewers need to evaluate the change without guessing. Use the `Bash` tool for `git diff <base>...HEAD` (default base `main`), and the `Explore` agent (or `Read`) to pull the full contents of the changed files.
   - The diff must be the **full unified diff including context lines**. If the environment routes git through a token-compressing wrapper or proxy, bypass it for this command — a summarized diff strips the surrounding code both rubrics reason over, and the reviewers will silently under-report.
3. Launch both subagents in the same message with `run_in_background: true`:
   - `subagent_type: "thermo-nuclear-reviewer"` for bugs, breakages, security, devex regressions, feature-flag leaks, and other branch-audit risks.
   - `subagent_type: "thermo-nuclear-code-quality-reviewer"` for maintainability, structure, file-size growth, spaghetti, abstractions, and codebase-health risks.
4. Pass each subagent the same scoped diff/file context and ask it to return prioritized findings with `file:line` references, a concrete failure scenario, a severity, and a category.
5. Collect both results with `TaskOutput` once they finish. Never write, predict, or paraphrase a result that has not arrived yet — wait for it.
6. Synthesize: merge the two lists, deduplicate across reviewers, and rank most-severe first. Weight a finding higher when both reviewers land on it independently, resolve disagreements with your own judgment, and drop anything you cannot substantiate against the diff.
7. Report the merged list with the `ReportFindings` tool so the findings render as a structured list rather than prose. Map each item to `file`, `line`, `summary`, `failure_scenario`, `category`, and `short_summary`. Do not also print the same findings as text. If `ReportFindings` is unavailable, fall back to a prioritized markdown list with the same fields.

If individual background summaries are already visible to the user, do not restate them wholesale. Surface the unified verdict, the highest-signal findings, and any remaining uncertainty.
