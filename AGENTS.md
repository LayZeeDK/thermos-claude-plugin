# Agent instructions

This repository ports Cursor's Thermos plugin (<https://github.com/cursor/plugins/tree/main/thermos>) to Claude Code.

## Porting rule

Stay as close to upstream Cursor Thermos's prose as possible. Change only frontmatter metadata and agent-specific terms such as tool names: Cursor's `Task` tool becomes the `Agent` tool, its `shell` subagent becomes the `Bash` or `PowerShell` tool, and its `explore` subagent becomes `subagent_type: "Explore"`. Every instruction in the skills and agents stays upstream's.

Claude Code-only frontmatter is fine when it makes upstream's intent work in Claude Code, as `skills:` preloading does for the reviewer agents.

The one intentional divergence: no skill sets `disable-model-invocation: true`, because in Claude Code that field also blocks the Skill tool and `skills:` preloading. Keep it removed, including from new upstream skills.

The porting rule binds `plugins/thermos` in full. `plugins/thermos-experimental` is generated from it by `tools/thermos-experimental-generator/`: its `lens-*` files move upstream lines between files but reword none, and every change to them goes through `slice-map.ts` and `npm run generate`, never a hand edit.

## Versioning and commits

- Pick each Conventional Commit type by its SemVer effect on the public interface that the CHANGELOG preamble defines. Pull requests merge with a merge commit, so every commit's type lands on `main`.
- Put the version bump and the CHANGELOG entry in their own commits, separate from the changes they describe.
- `thermos-experimental` stays at `0.x.y` and never releases 1.0. A breaking change to it (a `!` commit) bumps its minor version, and every other change bumps its patch version.

## Upstream syncs

Upstream syncs go through `/sync-from-cursor`. That skill sets `disable-model-invocation: true`, so ask the user to type it and let it drive the sync. After a sync, run `npm run generate` to carry the upstream changes into `thermos-experimental`.

## Verification

Verify plugin behaviour on Opus and Sonnet. Judge whether a reviewer agent received its rubric from the preloaded skill in its subagent transcript, not from the model's own answer. Fable 5.1 works but is unmeasured: run no Fable evals, `claude --model fable -p` sessions, or other Fable measurements.

Write maintainer scripts under `.claude/skills/` and `tools/` as TypeScript that Node.js runs directly (erasable syntax only), with `node:test` unit tests. Register table-driven tests with `testEach` from `tools/test-each/test-each.ts` or `testFor` from `tools/test-each/test-for.ts` instead of a loop of `it` calls: `testEach` spreads each row into the callback's arguments when every row is an array and passes no test context, and `testFor` passes the whole row and node:test's `TestContext`. Both deliberately mirror Vitest's `test.each` and `test.for`, title format included. Give each test its own state from a setup function it calls, as [SIFERS](https://medium.com/@kolodny/testing-with-sifers-c9d6bb5b362) describes, instead of `before` or `beforeEach` hooks that fill shared variables. Keep `npm run lint`, `npm run typecheck`, `npm test`, and `npm run mutate` passing; mutation testing requires a 100% score with every mutant killed, and a `// Stryker disable` comment needs a reason that shows the mutant is equivalent. Develop on the Node.js version in `.node-version` (`lts/krypton`, Node.js 24). `package.json` engines allows Node.js 22.18 and later, the oldest release that runs `.ts` files without flags, and CI also runs the latest Node.js 22; Claude Code's npm package supports Node.js 22 and later.
