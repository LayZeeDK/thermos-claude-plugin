// Prints, for each TypeScript file named on the command line, the mutants that this package's operators for that file
// add to and remove from what Stryker's own mutators make there:
//
//   node tools/stryker-node-mutators/corpus-diff.ts <file.ts>...
import { corpusDiff } from './mutant-diff.ts';
import { operatorsFor } from './operators.ts';

console.log(await corpusDiff(process.argv.slice(2), operatorsFor));
