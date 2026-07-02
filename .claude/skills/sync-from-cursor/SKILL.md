---
name: sync-from-cursor
description: Pull upstream changes from Cursor's Thermos plugin (the cursor/plugins monorepo) into this Claude Code port. Explicit-invocation-only maintainer skill (run /sync-from-cursor) for when you want to sync from cursor, pull upstream thermos changes, or update from cursor/plugins. Handles the monorepo path prefix and the verbatim-vs-transformed file split so upstream edits land safely instead of clobbering the Claude Code adaptations.
disable-model-invocation: true
---

# Sync from Cursor

This repo is a Claude Code port of Cursor's Thermos plugin. Upstream lives in a 17-plugin
monorepo (`cursor/plugins`) with Thermos under the `thermos/` subdirectory; here the plugin sits
at the repo root and most files were transformed for Claude Code. Two facts drive the whole
workflow:

- **The `thermos/` prefix must be stripped** so upstream paths match our root layout. `git diff --relative=thermos` does this on the fly.
- **Only the two rubric skills are byte-verbatim** with upstream, so only they can be auto-applied. Everything else (`thermos` orchestrator, agents, README, manifests, LICENSE, CHANGELOG) was rewritten for Claude Code and must be reconciled by hand -- auto-applying an upstream diff to them would clobber the port.

`git apply --3way` gives the safety net: verbatim files apply cleanly, and if upstream ever
edits them in a way that conflicts it leaves standard conflict markers rather than failing silently.

## Workflow

1. **Fetch upstream.** Ensure the read-only remote exists, then fetch:
   ```bash
   git remote get-url cursor >/dev/null 2>&1 || git remote add cursor https://github.com/cursor/plugins.git
   git fetch cursor
   ```

2. **Read the baseline.** The last-synced upstream commit is stored next to this skill:
   ```bash
   BASE=$(cat .claude/skills/sync-from-cursor/BASELINE)
   ```

3. **See what changed upstream** under Thermos since that baseline. If this is empty, you are already up to date -- stop here.
   ```bash
   git log --oneline "$BASE"..cursor/main -- thermos/
   ```

4. **Auto-apply the verbatim rubric skills.** These are the only files safe to apply mechanically. `--relative=thermos` rewrites `thermos/skills/...` to our root `skills/...`; `--3way` applies cleanly or leaves conflict markers:
   ```bash
   git diff "$BASE"..cursor/main --relative=thermos \
     -- thermos/skills/thermo-nuclear-review thermos/skills/thermo-nuclear-code-quality-review \
     | git apply --3way
   ```
   If there are no changes to these two skills, this is a harmless no-op. Resolve any conflict markers before continuing.

5. **Review the transformed files by hand.** For everything else, show the upstream diff and hand-port only the substantive changes into the Claude Code versions -- never pipe this into `git apply`:
   ```bash
   git diff "$BASE"..cursor/main --relative=thermos \
     -- thermos/skills/thermos thermos/agents thermos/README.md \
        thermos/.cursor-plugin/plugin.json thermos/LICENSE thermos/CHANGELOG.md
   ```
   Use the path map below to find each file's Claude Code counterpart. Preserve the port's
   adaptations (Claude frontmatter, `Bash`/`Explore`/`Task` orchestration, install commands,
   dual-copyright LICENSE); only carry over the actual upstream content changes.

6. **Advance the baseline** once the sync is applied and verified, so the next run diffs from here:
   ```bash
   git rev-parse cursor/main > .claude/skills/sync-from-cursor/BASELINE
   ```

Then review the working tree (`git status`, `git diff`) and commit the sync.

## Path map (upstream -> ours)

| Upstream (`cursor/plugins`) | This repo |
|:----------------------------|:----------|
| `thermos/skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` |
| `thermos/agents/<name>.md` | `agents/<name>.md` |
| `thermos/README.md` | `README.md` |
| `thermos/CHANGELOG.md` | `CHANGELOG.md` |
| `thermos/LICENSE` | `LICENSE` |
| `thermos/.cursor-plugin/plugin.json` | `.claude-plugin/plugin.json` |

## File buckets

**Verbatim -- auto-apply (step 4):**
- `skills/thermo-nuclear-review/SKILL.md`
- `skills/thermo-nuclear-code-quality-review/SKILL.md`

**Transformed -- review and hand-port (step 5), never auto-apply:**
- `skills/thermos/SKILL.md` (orchestration uses Claude Code `Bash`/`Explore`/`Task`)
- `agents/*.md` (Claude frontmatter: `model`, `color`; orchestration rewritten)
- `README.md` (port notice + Claude Code install commands)
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (Claude manifest layout)
- `LICENSE` (combined MIT: Cursor + porter)
- `CHANGELOG.md`

If a brand-new file appears upstream (a new skill or agent), decide which bucket it belongs to:
a pure rubric is usually verbatim; anything with Cursor-specific syntax needs porting.
