// What the thermos-experimental plugin is made of: every generated file names the upstream-identical file in
// plugins/thermos it comes from, and either the lines it takes from that file or the edits it makes to it.

/**
 * Picks lines from an upstream file. A string takes the one line that starts with it, plus the lines under it: a
 * heading's section up to the next heading at its level or above, or a list item's more deeply indented lines.
 * `line` takes the one line that starts with it and nothing under it, without the fragments in `drop`.
 */
export type Selector = string | { readonly line: string; readonly drop?: readonly string[] };

/**
 * Changes an upstream file. `from` replaces its one occurrence with `to`; `line` replaces the one line that starts
 * with it with the lines in `to`; `after` inserts the lines in `insert` after the one line that starts with it.
 */
export type Edit =
  | { readonly from: string; readonly to: string }
  | { readonly line: string; readonly to: readonly string[] }
  | { readonly after: string; readonly insert: readonly string[] };

export type FrontmatterValue = string | boolean | readonly string[];

interface GeneratedFile {
  /** Output path, relative to the repository root. */
  readonly path: string;
  /** Replaces the upstream file's frontmatter, written in this order. */
  readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  /** Upstream file, relative to the repository root. */
  readonly source: string;
}

/** A file made of upstream lines, written in upstream order. */
export interface SlicedFile extends GeneratedFile {
  readonly take: readonly Selector[];
}

/** An upstream file with edits applied. */
export interface EditedFile extends GeneratedFile {
  readonly edits: readonly Edit[];
}

export type FileSpec = SlicedFile | EditedFile;

const PLUGIN = 'thermos-experimental';
const OUT = `plugins/${PLUGIN}`;
const UPSTREAM = 'plugins/thermos';

/** The directories the generator owns; every file in them comes from the slice map. */
export const OUT_DIRS: readonly string[] = [`${OUT}/skills`, `${OUT}/agents`];

const DEEP_RUBRIC = `${UPSTREAM}/skills/thermo-nuclear-review/SKILL.md`;
const QUALITY_RUBRIC = `${UPSTREAM}/skills/thermo-nuclear-code-quality-review/SKILL.md`;
const ORCHESTRATOR = `${UPSTREAM}/skills/thermos/SKILL.md`;
const DEEP_AGENT = `${UPSTREAM}/agents/thermo-nuclear-reviewer.md`;
const QUALITY_AGENT = `${UPSTREAM}/agents/thermo-nuclear-code-quality-reviewer.md`;

/** The upstream files whose every non-blank line must land in at least one sliced file. */
export const SLICED_SOURCES: readonly string[] = [DEEP_RUBRIC, QUALITY_RUBRIC];

function rubric(name: string, source: string, preloadedBy: string, take: readonly Selector[]): SlicedFile {
  return {
    path: `${OUT}/skills/${name}/SKILL.md`,
    frontmatter: {
      name,
      description: `Internal rubric for ${PLUGIN}; preloaded by ${preloadedBy}.`,
      'user-invocable': false,
    },
    source,
    take,
  };
}

interface Agent {
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly skill: string;
  readonly shared: string;
}

function agent(source: string, upstreamSkill: string, upstreamAgent: string, a: Agent, edits: readonly Edit[]): EditedFile {
  return {
    path: `${OUT}/agents/${a.name}.md`,
    frontmatter: {
      name: a.name,
      description: a.description,
      color: a.color,
      skills: [`${PLUGIN}:${a.shared}`, `${PLUGIN}:${a.skill}`],
    },
    source,
    edits: [
      {
        from: `Load the \`${upstreamSkill}\` skill (shipped in the Thermos plugin)`,
        to: `Load the \`${a.skill}\` skill (shipped in the Thermos Experimental plugin)`,
      },
      { from: `subagent_type: "thermos:${upstreamAgent}"`, to: `subagent_type: "${PLUGIN}:${a.name}"` },
      ...edits,
    ],
  };
}

function lensDescription(focus: string, skill: string): string {
  return (
    `Experimental Thermos lens: ${focus}, scoped to the diff. Invoked via Agent by thermos-lenses after it gathers ` +
    `diff and file contents. Loads rubric from the ${skill} skill in the Thermos Experimental plugin.`
  );
}

const DEEP_SHARED = 'lens-review-shared';
const QUALITY_SHARED = 'lens-code-quality-shared';

const PROMPT = 'You are a security expert performing a comprehensive review';

const deepLenses = [
  {
    name: 'breakage',
    focus: 'bugs and changes that break existing functionality',
    color: 'red',
    take: [
      { line: '## Prompt' },
      { line: PROMPT, drop: [', and security vulnerabilities'] },
      { line: '# Guidelines' },
      '## Breaking Functionality Guidelines',
    ],
  },
  {
    name: 'security',
    focus: 'security vulnerabilities and feature-gate leaks',
    color: 'orange',
    take: [
      { line: '## Prompt' },
      { line: PROMPT, drop: ['bugs, changes that break existing features/functionality, and '] },
      { line: '# Guidelines' },
      '## Feature Leak Guidelines',
    ],
  },
  {
    name: 'devex',
    focus: "changes that break developers' ability to run or build the code locally",
    color: 'pink',
    take: [{ line: '## Prompt' }, PROMPT, { line: '# Guidelines' }, '## Breaking Devex Guidelines'],
  },
] as const;

const qualityLenses = [
  {
    name: 'simplification',
    focus: 'structural regressions and missed code-judo simplifications',
    color: 'yellow',
    take: [
      '0. **Be ambitious about structural simplification.**',
      '3. **Bias toward cleaning the design',
      '- Is there a "code judo" move',
      '- Can this change be reframed',
      '- Does this improve or worsen the local architecture?',
      '- A complicated implementation where a cleaner reframing',
      '- Refactors that move code around',
      '- Refactors that technically pass tests',
      '- Delete a whole layer of indirection',
      '- Reframe the state model',
      '- Change the ownership boundary',
      '- Turn special-case logic into a simpler default flow',
      '- Collapse duplicate branches',
      '- no clear structural regression',
      '- no obvious missed opportunity to make the implementation dramatically simpler',
      '- the PR preserves a lot of incidental complexity',
    ],
  },
  {
    name: 'sprawl',
    focus: 'file-size growth past 1k lines and spaghetti branching',
    color: 'green',
    take: [
      '1. **Do not let a PR push a file',
      '2. **Do not allow random spaghetti growth',
      '- Did the diff add branching complexity',
      '- Did a previously cohesive module',
      '- Did this change enlarge a file',
      '- Are there repeated conditionals',
      '- Is the implementation direct and legible',
      '- A file crossing 1000 lines',
      '- New conditionals bolted onto',
      '- One-off booleans',
      '- Narrow edge-case handling',
      '- "Temporary" branching',
      '- Extract a helper or pure function.',
      '- Split a large file',
      '- Move feature-specific logic behind a dedicated abstraction.',
      '- Replace condition chains',
      '- no unjustified file-size explosion',
      '- no obvious spaghetti-growth',
      '- no missed opportunity for an obvious decomposition',
      '- the PR pushes a file from below 1000 lines',
      '- the PR adds ad-hoc branching',
    ],
  },
  {
    name: 'contracts',
    focus: 'magic abstractions, thin wrappers, and type and boundary contracts',
    color: 'cyan',
    take: [
      '4. **Prefer direct, boring, maintainable code',
      '5. **Push hard on type and boundary cleanliness',
      '- Is the implementation direct and legible',
      '- Is this abstraction actually earning its keep',
      '- Did the diff introduce casts',
      '- Generic "magic" handling',
      '- Thin wrappers or identity abstractions',
      '- Unnecessary casts',
      '- Delete wrappers that do not',
      '- Make type boundaries more explicit',
      '- no obviously hacky or magical abstraction',
      '- no unnecessary wrapper/cast/optionality churn',
      '- the PR adds an unnecessary abstraction, wrapper, or cast-heavy contract',
    ],
  },
  {
    name: 'layering',
    focus: 'logic in the wrong layer, duplicated helpers, and sequential or non-atomic orchestration',
    color: 'blue',
    take: [
      '6. **Keep logic in the canonical layer',
      '7. **Treat unnecessary sequential orchestration',
      '- Is this logic living in the right file and layer?',
      '- Is this logic living in the canonical layer',
      '- Is this orchestration more sequential',
      '- Feature-specific logic leaking into general-purpose modules.',
      '- Copy-pasted logic',
      '- Bespoke helpers where the codebase',
      '- Logic added in the wrong layer',
      '- Sequential async flow',
      '- Partial-update logic',
      '- Separate orchestration from business logic.',
      '- Reuse the existing canonical helper',
      '- Move the logic to the package/module/layer',
      '- Parallelize independent work',
      '- Restructure related updates',
      '- no clear architecture-boundary leak',
      '- the PR solves a local problem by scattering feature checks',
      '- the PR duplicates an existing helper',
    ],
  },
] as const;

/** Section and list headings that every code-quality lens repeats before its own items. */
const QUALITY_FRAME: readonly Selector[] = [
  { line: '## Non-Negotiable Additional Standards' },
  { line: 'Apply the baseline prompt above' },
  { line: '## Primary Review Questions' },
  { line: 'For every meaningful change, ask:' },
  { line: '## What to Flag Aggressively' },
  { line: 'Escalate findings when you see:' },
  { line: '## Preferred Remedies' },
  { line: 'When you identify a code-quality problem' },
  { line: '## Approval Bar' },
  { line: 'The bar for approval is:' },
  { line: 'Treat these as presumptive blockers' },
];

const reviewer = (lens: string) => `lens-${lens}-reviewer`;
const review = (lens: string) => `lens-${lens}-review`;

const orchestratorLensLine = ({ name, focus }: { readonly name: string; readonly focus: string }) =>
  `   - \`subagent_type: "${PLUGIN}:${reviewer(name)}"\` for ${focus}.`;

export const FILES: readonly FileSpec[] = [
  {
    path: `${OUT}/skills/thermos-lenses/SKILL.md`,
    frontmatter: {
      name: 'thermos-lenses',
      description:
        'Experimental: run the Thermos review as seven narrow lens subagents in parallel, reconcile PR discussion, ' +
        'then synthesize their findings. Use only when asked for thermos-lenses by name.',
      'argument-hint': '[branch, PR, commit or range] [--effort <level>] [--model <model>]',
    },
    source: ORCHESTRATOR,
    edits: [
      { from: '# Thermos', to: '# Thermos Lenses' },
      { from: 'Run the two thermo review passes', to: 'Run the seven thermo review lenses' },
      { from: 'Launch both subagents', to: 'Launch all seven lens subagents' },
      { line: '   - `subagent_type: "thermos:thermo-nuclear-reviewer"`', to: deepLenses.map(orchestratorLensLine) },
      { line: '   - `subagent_type: "thermos:thermo-nuclear-code-quality-reviewer"`', to: qualityLenses.map(orchestratorLensLine) },
      {
        after: '4. Pass each subagent the same scoped diff/file context',
        insert: [
          `5. If there is a PR for this branch and the breakage, security, or devex lens reported medium-or-higher ` +
            `findings, launch \`subagent_type: "${PLUGIN}:lens-pr-discussion-reconciler"\` after those three ` +
            `finish. Pass it their findings and the same scoped diff/file context.`,
        ],
      },
      { from: '5. After both finish', to: '6. After all reviewers finish' },
    ],
  },
  rubric(DEEP_SHARED, DEEP_RUBRIC, 'every thermos-lenses deep-review agent', [
    { line: '# Thermo Nuclear Review' },
    'Use this skill for a comprehensive security and correctness audit',
    '# Scope',
    { line: '# Guidelines' },
    '## Intended Breakage Guidelines',
    '## Over-reporting Guidelines',
    { line: '# Critical Rules' },
    '- NEVER present issues with unfinished research.',
    '- Be EXTREMELY thorough',
  ]),
  ...deepLenses.map(({ name, take }) => rubric(review(name), DEEP_RUBRIC, reviewer(name), take)),
  rubric(review('pr-discussion'), DEEP_RUBRIC, 'lens-pr-discussion-reconciler', [
    '# Final Response',
    { line: '# Critical Rules' },
    '- You MUST wait to check the PR/MR discussion',
  ]),
  rubric(QUALITY_SHARED, QUALITY_RUBRIC, 'every thermos-lenses code-quality agent', [
    { line: '# Thermo-Nuclear Code Quality Review' },
    'Use this skill for an unusually strict review',
    'Above all, this skill should push the reviewer',
    '## Core Prompt',
    'Do not be satisfied with "maybe rename this"',
    'Do not be satisfied with a merely cleaner version',
    '## Review Tone',
    '## Output Expectations',
    { line: '## Approval Bar' },
    'Do not approve merely because behavior seems correct.',
    'If those conditions are not met',
  ]),
  ...qualityLenses.map(({ name, take }) =>
    rubric(review(name), QUALITY_RUBRIC, reviewer(name), [...QUALITY_FRAME, ...take]),
  ),
  ...deepLenses.map(({ name, focus, color }) =>
    agent(
      DEEP_AGENT,
      'thermo-nuclear-review',
      'thermo-nuclear-reviewer',
      { name: reviewer(name), description: lensDescription(focus, review(name)), color, skill: review(name), shared: DEEP_SHARED },
      [
        { line: '3. After the audit', to: [] },
        { from: '4. **Never**', to: '3. **Never**' },
      ],
    ),
  ),
  agent(
    DEEP_AGENT,
    'thermo-nuclear-review',
    'thermo-nuclear-reviewer',
    {
      name: 'lens-pr-discussion-reconciler',
      description:
        'Experimental Thermos PR-discussion reconciler: checks the deep-review lens findings against BugBot and ' +
        'human PR/MR threads. Invoked via Agent by thermos-lenses after the lenses finish. Loads rubric from the ' +
        'lens-pr-discussion-review skill in the Thermos Experimental plugin.',
      color: 'purple',
      skill: review('pr-discussion'),
      shared: DEEP_SHARED,
    },
    [
      { line: '1. Perform the full audit', to: [] },
      { line: '2. Finish your **independent** audit', to: [] },
      { from: '3. After the audit', to: '1. After the audit' },
      { from: '4. **Never**', to: '2. **Never**' },
    ],
  ),
  ...qualityLenses.map(({ name, focus, color }) =>
    agent(
      QUALITY_AGENT,
      'thermo-nuclear-code-quality-review',
      'thermo-nuclear-code-quality-reviewer',
      { name: reviewer(name), description: lensDescription(focus, review(name)), color, skill: review(name), shared: QUALITY_SHARED },
      [],
    ),
  ),
];
