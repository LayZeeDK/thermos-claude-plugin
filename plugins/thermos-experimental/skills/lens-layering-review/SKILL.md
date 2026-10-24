---
name: "lens-layering-review"
description: "Internal rubric for thermos-experimental; preloaded by lens-layering-reviewer."
user-invocable: false
---

## Non-Negotiable Additional Standards

Apply the baseline prompt above, plus these explicit review rules:

6. **Keep logic in the canonical layer and reuse existing helpers.**
   - Call out feature logic leaking into shared paths or implementation details leaking through APIs.
   - Prefer existing canonical utilities/helpers over bespoke one-offs.
   - Push code toward the right package, service, or module instead of normalizing architectural drift.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.**
   - If independent work is serialized for no good reason, ask whether the flow should run in parallel instead.
   - If related updates can leave state half-applied, push for a more atomic structure.
   - Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation more brittle.

## Primary Review Questions

For every meaningful change, ask:

- Is this logic living in the right file and layer?
- Is this logic living in the canonical layer, or did the diff leak details across a boundary?
- Is this orchestration more sequential or less atomic than it needs to be?

## What to Flag Aggressively

Escalate findings when you see:

- Feature-specific logic leaking into general-purpose modules.
- Copy-pasted logic instead of extracted helpers.
- Bespoke helpers where the codebase already has a canonical utility for the job.
- Logic added in the wrong layer/package when it should live somewhere more central.
- Sequential async flow where obviously independent work could stay simpler and clearer with parallel execution.
- Partial-update logic that leaves state less atomic than necessary.

## Preferred Remedies

When you identify a code-quality problem, prefer suggestions like:

- Separate orchestration from business logic.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Move the logic to the package/module/layer that already owns the concept.
- Parallelize independent work when that also simplifies the orchestration.
- Restructure related updates into a more atomic flow when partial state would be harder to reason about.

## Approval Bar

The bar for approval is:

- no clear architecture-boundary leak or avoidable canonical-helper duplication

Treat these as presumptive blockers unless the author can justify them clearly:

- the PR solves a local problem by scattering feature checks across shared code
- the PR duplicates an existing helper or puts logic in the wrong layer when there is a clear canonical home
