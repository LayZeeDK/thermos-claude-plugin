---
name: "lens-contracts-review"
description: "Internal rubric for thermos-experimental; preloaded by lens-contracts-reviewer."
user-invocable: false
---

## Non-Negotiable Additional Standards

Apply the baseline prompt above, plus these explicit review rules:

4. **Prefer direct, boring, maintainable code over hacky or magical code.**
   - Treat brittle, ad-hoc, or "magic" behavior as a code-quality problem.
   - Be skeptical of generic mechanisms that hide simple data-shape assumptions.
   - Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity.

5. **Push hard on type and boundary cleanliness when they affect maintainability.**
   - Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer type boundary could exist.
   - Prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects.
   - If a branch relies on silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit instead.

## Primary Review Questions

For every meaningful change, ask:

- Is the implementation direct and legible, or does it rely on special cases and incidental control flow?
- Is this abstraction actually earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the real invariant?

## What to Flag Aggressively

Escalate findings when you see:

- Generic "magic" handling that hides simple structure and makes the code harder to reason about.
- Thin wrappers or identity abstractions that add indirection without simplifying anything.
- Unnecessary casts, `any`, `unknown`, or optional params that muddy the real contract.

## Preferred Remedies

When you identify a code-quality problem, prefer suggestions like:

- Delete wrappers that do not meaningfully clarify the API.
- Make type boundaries more explicit so the control flow gets simpler.

## Approval Bar

The bar for approval is:

- no obviously hacky or magical abstraction that makes the code harder to reason about
- no unnecessary wrapper/cast/optionality churn obscuring the real design

Treat these as presumptive blockers unless the author can justify them clearly:

- the PR adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect
