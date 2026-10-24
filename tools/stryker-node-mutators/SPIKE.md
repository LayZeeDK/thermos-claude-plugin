# Spike notes: Node.js mutators

## Corpus diff

`corpus-diff.ts` instruments each file with Stryker's real instrumenter twice, once with Stryker's 17 mutators and
once with this package's operators added after them, and lists the mutants that differ. A `-` line is a mutant that
a mutator's filter drops once an operator's mutant shares its scope. Each section below records the run made when
that operator landed, with `@stryker-mutator/instrumenter` 10.1.1, from the worktree root. A run applies every operator
in `operators.ts` at the time, so each section lists only what its operator changed.

### AssertLiveness

Run on 2026-10-25 with `AssertLiveness` the only operator (the run took about one second):

```sh
R=tools/stryker-node-test-runner
node tools/stryker-node-mutators/corpus-diff.ts $R/dirs.ts $R/hook.ts $R/hook-core.ts $R/index.ts \
  $R/memory-limits.ts $R/process-end.ts $R/reporter.ts $R/watchdog.ts $R/watchdog-worker.ts \
  $R/process-end.test.ts tools/test-each/register.test.ts
```

What it shows:

- The nine production files of the runner: no difference. No runner file imports `node:assert`, so `AssertLiveness`
  finds nothing there and removes nothing.
- `process-end.test.ts`: 15 `AssertLiveness` mutants, one per assertion statement in the file (lines 15 to 179).
- `register.test.ts`: 12 `AssertLiveness` mutants, among them the `t.assert` calls at lines 11, 31, 36 and 48. The
  `t.assert.reports` call at line 76 is an argument of `assert.rejects`, not a statement, and is left alone.
- Removed: 7 `CallExpression` statement removals, at the assertion statements whose arguments carry no other mutant.
  The `CallExpression` mutator keeps its mutant only when it is the only one in the statement, and the
  `AssertLiveness` mutant now shares the statement. This matters only when the operator is added next to Stryker's
  mutators; `test-code.ts` replaces them, so a test-code run has no `CallExpression` mutants to lose.
- Line 36 of `register.test.ts` is inside a function that `t.assert.reports` checks for captured variables. Whether
  that function still works once Stryker instruments it is for the test-code `stryker run` to show.

Output:

```text
### tools/stryker-node-test-runner/dirs.ts

68 mutants without the operators, 68 with them.

    (no difference)

### tools/stryker-node-test-runner/hook.ts

20 mutants without the operators, 20 with them.

    (no difference)

### tools/stryker-node-test-runner/hook-core.ts

401 mutants without the operators, 401 with them.

    (no difference)

### tools/stryker-node-test-runner/index.ts

428 mutants without the operators, 428 with them.

    (no difference)

### tools/stryker-node-test-runner/memory-limits.ts

41 mutants without the operators, 41 with them.

    (no difference)

### tools/stryker-node-test-runner/process-end.ts

54 mutants without the operators, 54 with them.

    (no difference)

### tools/stryker-node-test-runner/reporter.ts

5 mutants without the operators, 5 with them.

    (no difference)

### tools/stryker-node-test-runner/watchdog.ts

14 mutants without the operators, 14 with them.

    (no difference)

### tools/stryker-node-test-runner/watchdog-worker.ts

1 mutants without the operators, 1 with them.

    (no difference)

### tools/stryker-node-test-runner/process-end.test.ts

143 mutants without the operators, 154 with them.

    + 15:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 40:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 48:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 56:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 102:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 113:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 122:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 123:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 132:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 144:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 155:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 166:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 170:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 171:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 179:5 AssertLiveness throw new Error("Stryker: assertion reached");
    - 15:5 CallExpression ;
    - 122:5 CallExpression ;
    - 132:5 CallExpression ;
    - 179:5 CallExpression ;

### tools/test-each/register.test.ts

192 mutants without the operators, 201 with them.

    + 11:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 31:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 36:11 AssertLiveness throw new Error("Stryker: assertion reached");
    + 48:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 65:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 66:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 67:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 75:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 94:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 105:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 109:5 AssertLiveness throw new Error("Stryker: assertion reached");
    + 120:5 AssertLiveness throw new Error("Stryker: assertion reached");
    - 36:11 CallExpression ;
    - 94:5 CallExpression ;
    - 120:5 CallExpression ;
```

### NodeTimerDelay

Run on 2026-10-25 over the runner's nine production files, with `NodeTimerDelay` and `AssertLiveness` (under a
second):

```sh
R=tools/stryker-node-test-runner
node tools/stryker-node-mutators/corpus-diff.ts $R/dirs.ts $R/hook.ts $R/hook-core.ts $R/index.ts \
  $R/memory-limits.ts $R/process-end.ts $R/reporter.ts $R/watchdog.ts $R/watchdog-worker.ts
```

6 mutants added at the three timer sites, none removed; the other six files show no difference. The added mutants sit
on the delay argument, where no built-in mutator places one, so no built-in mutant gives way.

```text
### tools/stryker-node-test-runner/dirs.ts

68 mutants without the operators, 70 with them.

    + 43:8 NodeTimerDelay waitMs + 1
    + 43:8 NodeTimerDelay waitMs - 1

### tools/stryker-node-test-runner/process-end.ts

54 mutants without the operators, 56 with them.

    + 76:10 NodeTimerDelay graceMs + 1
    + 76:10 NodeTimerDelay graceMs - 1

### tools/stryker-node-test-runner/watchdog.ts

14 mutants without the operators, 16 with them.

    + 36:47 NodeTimerDelay 50 + 1
    + 36:47 NodeTimerDelay 50 - 1
```
