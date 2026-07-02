# Changelog

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
