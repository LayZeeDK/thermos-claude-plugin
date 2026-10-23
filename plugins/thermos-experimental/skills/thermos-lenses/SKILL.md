---
name: "thermos-lenses"
description: "Experimental: run the Thermos review as seven narrow lens subagents in parallel, reconcile PR discussion, then synthesize their findings. Use only when asked for thermos-lenses by name."
argument-hint: "[branch, PR, commit or range] [--effort <level>] [--model <model>]"
---

# Thermos Lenses

Run the seven thermo review lenses as async background subagents in parallel, then synthesize their results.

## Workflow

1. Determine the review scope from the user request, PR, current branch, or relevant changed files.
2. Gather the diff and any file/context excerpts needed for reviewers to evaluate the change without guessing.
3. Launch all seven lens subagents in the same message with `run_in_background: true`:
   - `subagent_type: "thermos-experimental:lens-breakage-reviewer"` for bugs and changes that break existing functionality.
   - `subagent_type: "thermos-experimental:lens-security-reviewer"` for security vulnerabilities and feature-gate leaks.
   - `subagent_type: "thermos-experimental:lens-devex-reviewer"` for changes that break developers' ability to run or build the code locally.
   - `subagent_type: "thermos-experimental:lens-simplification-reviewer"` for structural regressions and missed code-judo simplifications.
   - `subagent_type: "thermos-experimental:lens-sprawl-reviewer"` for file-size growth past 1k lines and spaghetti branching.
   - `subagent_type: "thermos-experimental:lens-contracts-reviewer"` for magic abstractions, thin wrappers, and type and boundary contracts.
   - `subagent_type: "thermos-experimental:lens-layering-reviewer"` for logic in the wrong layer, duplicated helpers, and sequential or non-atomic orchestration.
4. Pass each subagent the same scoped diff/file context and ask it to return prioritized findings with file references and evidence.
5. If there is a PR for this branch and the breakage, security, or devex lens reported medium-or-higher findings, launch `subagent_type: "thermos-experimental:lens-pr-discussion-reconciler"` after those three finish. Pass it their findings as the audit to reconcile, and the same scoped diff/file context.
6. After all reviewers finish, synthesize the results with findings first, deduplicated across reviewers. Weight overlapping findings more heavily, resolve disagreements with your own judgment, and keep summaries brief.

If individual background summaries are already visible to the user, do not restate them wholesale. Surface the unified verdict, the highest-signal findings, and any remaining uncertainty.
