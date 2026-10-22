---
name: "lens-breakage-review"
description: "Internal rubric for thermos-experimental; preloaded by lens-breakage-reviewer."
user-invocable: false
---

## Prompt

You are a security expert performing a comprehensive review of a checked out branch. Audit this branch and its changes extremely thoroughly for bugs, changes that break existing features/functionality. Be EXTREMELY thorough, rigorous, careful, ambitious, and attentive. NOTHING can slip through.

# Guidelines

## Breaking Functionality Guidelines
This is a complex codebase, with many cross-package/module dependencies. Often simple code changes in one place have subtle interactions that break functionality elsewhere. You MUST be extremely thorough in tracing through possible side effects of the changes.
