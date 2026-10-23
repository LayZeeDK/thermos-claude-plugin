# Changelog

This plugin uses [Semantic Versioning](https://semver.org/) and stays at `0.x.y`: it never releases 1.0. A breaking change bumps the minor version (`0.1.0` -> `0.2.0`), and every other change bumps the patch version. Its public interface is the plugin name, the skill names and their slash commands, the agent names that callers pass as `subagent_type`, who may invoke each skill, and the prompt sections the agents expect. Each release names the Cursor Thermos version and upstream commit it is based on.

## 0.1.0

Based on Cursor Thermos 1.0.0 @ [`0452e08`](https://github.com/cursor/plugins/tree/0452e08a314c03621ec5ac1324f1ad1dd824f1a4/thermos).

First release, with one entry point: `/thermos-experimental:thermos-lenses`. It splits the Thermos review into seven narrow lens reviewers and a PR-discussion reconciler. Every skill and agent is generated from the `thermos` plugin 1.1.0 files, which keep upstream's rubric text.

How the lens files differ from upstream:

- The two rubrics are split into ten skills. Each takes upstream lines in upstream order and adds no wording of its own. `lens-review-shared` and `lens-code-quality-shared` hold the lines every lens of a family needs, and each code-quality lens repeats upstream's section and list headings before its own items. The `-shared` skills and the `lens-*-review` skills set `user-invocable: false`.
- The breakage and security lenses take upstream's opening prompt with part of its list removed. The breakage lens audits "for bugs, changes that break existing features/functionality." and the security lens "for security vulnerabilities." The devex lens takes the whole sentence.
- The deep-review rubric's "Final Response" section and its rule to check the PR/MR discussion only after the audit move to `lens-pr-discussion-review`. The lens agents never read the PR discussion, so their review stays independent of it. The reconciler reads it.
- Each lens agent keeps the body of the upstream agent for its family. Its "Load the ... skill" step names its lens skill and says "(shipped in the Thermos Experimental plugin)", and its "Parent orchestration" section names its own `subagent_type`. The deep-review lens agents drop step 3 of "Work", which reads the PR discussion. The reconciler keeps only that step and the "never present issues with unfinished research" step.
- Each agent preloads its lens skill and its family's `-shared` skill through `skills:`. The reconciler also preloads `lens-review-shared`, so it judges BugBot and human findings by the same scope and over-reporting rules as the lenses.
- The `thermos-lenses` orchestrator keeps upstream's `thermos` workflow. Step 3 launches the seven lenses instead of two reviewers, a new step 5 launches the reconciler, and step 6 synthesizes after all reviewers finish. Its `argument-hint` matches `thermos`: `[branch, PR, commit or range] [--effort <level>] [--model <model>]`.
- Agent colors: `red`, `orange`, and `pink` for the breakage, security, and devex lenses; `yellow`, `green`, `cyan`, and `blue` for the simplification, sprawl, contracts, and layering lenses; `purple` for the reconciler.
- The agents set no `model`, `effort`, `tools`, or `disallowedTools`, like the `thermos` agents.
