# Changelog

This port uses [Semantic Versioning](https://semver.org/). Its public interface is the plugin name, the skill names and their slash commands, the agent names that callers pass as `subagent_type`, who may invoke each skill, and the prompt sections the agents expect. The port's version number does not follow upstream's. From 1.1.0 on, each release names the Cursor Thermos version and upstream commit it is based on.

## 1.1.0

Based on Cursor Thermos 1.0.0 @ [`0452e08`](https://github.com/cursor/plugins/tree/0452e08a314c03621ec5ac1324f1ad1dd824f1a4/thermos).

**This release intentionally diverges from upstream Cursor Thermos.** Every skill drops upstream's `disable-model-invocation: true` line. The two rubric skills' bodies are still byte-identical to upstream, and the `thermos` skill's body differs only in the plugin-qualified agent names.

In Cursor, `disable-model-invocation` only stops the main agent from applying a skill on its own. In Claude Code, it also makes the Skill tool refuse the skill, for the main agent and for subagents, and it stops the `skills:` frontmatter field from preloading the skill into a subagent. While the field was set:

- The reviewer agents could never load their rubric. The Skill tool refused their "Load the ... skill" step, so they reviewed with the short fallback instructions instead.
- A reviewer spawned by another subagent got the same refusal.
- Autonomous sessions could not start `/thermos` or either rubric. Nobody types the slash command in such a session, and the model was not allowed to invoke it.

Changes:

- `thermo-nuclear-review`, `thermo-nuclear-code-quality-review`, and `thermos`: removed `disable-model-invocation: true`. Claude can now invoke these skills on its own when a request matches their descriptions, and the three descriptions now appear in the skill listing in every session.
- `thermo-nuclear-reviewer` and `thermo-nuclear-code-quality-reviewer`: added a `skills:` field that preloads the agent's rubric, `thermos:thermo-nuclear-review` or `thermos:thermo-nuclear-code-quality-review`, whenever the agent starts, however deeply it is nested. The agent prose is unchanged, and its "Load the ... skill" step now finds the rubric already loaded.
- `/sync-from-cursor`, the maintainer skill: notes the one-line frontmatter difference from upstream, how to resolve a `--3way` conflict next to it, and that new upstream skills also lose `disable-model-invocation`. Its path map now names the renamed agent files, which it had mapped to their upstream names since 1.0.1.
- `thermos` orchestrator step 5 and the README's third usage step: removed the `TaskOutput` step. Claude Code removed that tool in v2.1.277, and background subagents now report back with a completion notification. Both use upstream's wording again, "After both finish, synthesize the results ..." in the skill and "Synthesize prioritized, deduped findings." in the README.
- `thermos` orchestrator step 2: restored upstream's wording, "Gather the diff and any file/context excerpts needed for reviewers to evaluate the change without guessing." The port had added a sentence naming `Bash`, `Explore`, and `Read`. The README's first two usage steps had similar additions and now match upstream's README. In six `/thermos` runs, three with each wording, the orchestrator gathered context the same way and gave the reviewers the same kind of brief, so the port keeps upstream's text.
- Both agents and the README's agent table: swapped Cursor's `Task` for Claude Code's `Agent` wherever upstream names the tool, and changed nothing else. The descriptions say "Invoked via Agent", the agents open with "You are an **Agent subagent**.", and the table rows read "Agent subagent for ... rubric (diff-scoped)." Claude Code renamed `Task` to `Agent` in v2.1.63 and keeps `Task` only as an alias.
- `thermos` orchestrator step 3 and both agents' "Parent orchestration" sections: `subagent_type` now uses the plugin-qualified names `thermos:thermo-nuclear-reviewer` and `thermos:thermo-nuclear-code-quality-reviewer`. Claude Code registers plugin agents under the plugin's name, and an Agent call with the bare name fails with "Agent type 'thermo-nuclear-reviewer' not found".
- `plugin.json`: added `displayName: "Thermos"`, which upstream's Cursor manifest also sets, and `icon: "./assets/logo.png"`, which points at a copy of upstream's logo. Anthropic's plugin directory reads `icon`, and Claude Code ignores it.
- `plugin.json`: added `metadata.upstream` with the `version` and `commit` of the Cursor Thermos release this one is based on. `/sync-from-cursor` reads its baseline there, and its new `advance-baseline.ts` script, which is type-checked and unit-tested, updates the field and prints the "Based on Cursor Thermos ..." line for the CHANGELOG. The separate `BASELINE` file is gone.
- `thermos`: added `argument-hint: "[branch, PR, commit or range] [--effort <level>] [--model <model>]"`. Claude Code shows the hint while you type `/thermos`, and Cursor has no such field. Adding `--effort <level>` runs both reviewers at that effort level through the Agent tool's per-call `effort` parameter, which needs Claude Code v2.1.292 or later. Adding `--model <model>` runs both reviewers on that model through the Agent tool's per-call `model` parameter. The README's usage section documents both.
- Both agents: removed `model: inherit`, because upstream sets no `model`. Without the field, an agent still runs on the main conversation's model. If you set `CLAUDE_CODE_SUBAGENT_MODEL`, it now applies to these agents, where `inherit` used to override it. A model passed on the Agent call still overrides both.
- Both agents' "Parent orchestration" sections: restored upstream's sentence, which gathers the diff and the changed files in one message and in parallel, and swapped only its tool names. Cursor's `shell` subagent becomes "the `Bash` or `PowerShell` tool", because Cursor's shell subagent doesn't assume a particular shell and Claude Code on Windows turns on the PowerShell tool automatically when Git Bash is missing. `subagent_type: "explore"` becomes Claude Code's `subagent_type: "Explore"`, and "two `Task` calls" becomes "two tool calls", since one of the two is now a tool rather than a subagent.
- `thermos` orchestrator intro and the README title: restored upstream's wording, "async background subagents" and "# Thermos plugin". The port notice under the title already says this is a Claude Code port.

## 1.0.1

Renamed both agents to follow Claude Code's role-based naming convention, dropping the `-subagent` suffix (a Cursor-ism; Claude Code names subagents like `code-reviewer`, `security-auditor`).

- `thermo-nuclear-review-subagent` -> `thermo-nuclear-reviewer`
- `thermo-nuclear-code-quality-review-subagent` -> `thermo-nuclear-code-quality-reviewer`

Updated all references: agent frontmatter `name`, the self-documented `subagent_type` invocation examples, the `thermos` orchestrator skill's `subagent_type` targets, and the README architecture diagram and agent table. Agent files renamed to match. Colors (`red` for the deep review agent, `yellow` for the code-quality agent) were validated against Claude Code's supported set (`red, blue, green, yellow, purple, orange, pink, cyan`) and kept as-is -- both are valid, distinct within the plugin, and semantically appropriate (red = security/critical, yellow = validation/quality).

## 1.0.0

Initial Claude Code port of Cursor's Thermos plugin (<https://github.com/cursor/plugins/tree/main/thermos>). The sections below summarize, at a high level, how each ported skill and agent file differs from its Cursor Thermos original.

### Skills

- `thermo-nuclear-review` (deep review rubric): ported **byte-for-byte** from upstream. No body or frontmatter changes; upstream's `disable-model-invocation: true` is retained.
- `thermo-nuclear-code-quality-review` (code quality rubric): ported **byte-for-byte** from upstream. No body or frontmatter changes.
- `thermos` (orchestrator): frontmatter kept as-is (`name`, `description`, `disable-model-invocation: true`). Body changes:
  - Diff-gathering rewritten to Claude Code primitives -- the `Bash` tool for `git diff <base>...HEAD` and the `Explore` agent (or `Read`) for changed-file contents (upstream left the gathering mechanism implicit).
  - Added a `TaskOutput` step to collect the background subagents' results before synthesis.
  - Wording aligned to Claude Code's background-task model (dropped "async"); retained the two `subagent_type` targets and `run_in_background: true`.

### Agents

Both subagents (`thermo-nuclear-review-subagent`, `thermo-nuclear-code-quality-review-subagent`) received the same class of changes:

- Frontmatter: added Claude Code fields `model: inherit` and `color` (`red` for deep review, `yellow` for code quality); reworded "Invoked via Task" to "Invoked via the Task tool". `name` and `description` intent otherwise preserved.
- Dropped Cursor's "Task subagent" terminology ("You are a **Task subagent**" -> "You are a subagent").
- Rewrote the "Parent orchestration" section: replaced Cursor's parallel `subagent_type: "shell"` + `subagent_type: "explore"` gathering with Claude Code's `Bash` tool (for `git diff`) and `Explore` agent (for changed-file contents).
- Unchanged: the rubric-loading and work sections, the fresh-eyes + `gh`/`glab` PR/MR-discussion flow, honest severity calibration, and the "do not spawn nested subagents" rule.

### Packaging and docs

- Split Cursor's single `.cursor-plugin/plugin.json` into a Claude Code `.claude-plugin/plugin.json` plus a new `.claude-plugin/marketplace.json`, so the repo installs as a single-plugin marketplace. Dropped Cursor-only manifest fields (`displayName`, `logo`, `category`, `tags`, and the `skills`/`agents` path pointers -- skills and agents are auto-discovered); `category`/`tags` moved to the marketplace entry; `author`, `homepage`, and `repository` retargeted to this port.
- README: added a port notice crediting Cursor, replaced `/add-plugin thermos` with `/plugin marketplace add` + `/plugin install`, retargeted "Cursor agents" -> "Claude Code agents", and removed the Cursor-specific "Migration from cursor-team-kit" section. Architecture diagram retained as a mermaid block.
- LICENSE: combined MIT notice naming both Cursor (original) and the porter.
