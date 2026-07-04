---
name: thermos
description: "Launch both thermo-nuclear review subagents in parallel, then synthesize their findings. Use for thermos, double thermo review, or combined bug/security and code-quality branch audits."
disable-model-invocation: true
---

# Thermos

Run the two thermo review passes as background subagents in parallel, then synthesize their results.

## Workflow

1. Determine the review scope from the user request, PR, current branch, or relevant changed files.
2. Gather the diff and any file/context excerpts the reviewers need to evaluate the change without guessing. Use the `Bash` tool for `git diff <base>...HEAD` (default base `main`), and the `Explore` agent (or `Read`) to pull the full contents of the changed files.
3. Launch both subagents in the same message with `run_in_background: true`:
   - `subagent_type: "thermo-nuclear-reviewer"` for bugs, breakages, security, devex regressions, feature-flag leaks, and other branch-audit risks.
   - `subagent_type: "thermo-nuclear-code-quality-reviewer"` for maintainability, structure, file-size growth, spaghetti, abstractions, and codebase-health risks.
4. Pass each subagent the same scoped diff/file context and ask it to return prioritized findings with file references and evidence.
5. Collect both results with `TaskOutput` once they finish, then synthesize with findings first, deduplicated across reviewers. Weight overlapping findings more heavily, resolve disagreements with your own judgment, and keep summaries brief.

If individual background summaries are already visible to the user, do not restate them wholesale. Surface the unified verdict, the highest-signal findings, and any remaining uncertainty.
