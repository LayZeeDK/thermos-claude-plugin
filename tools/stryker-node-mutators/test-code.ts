// A Stryker configuration file that mutates test files imports this module, so that an error in the install stops the
// run.
import { install } from './install.ts';
import { testOperators } from './operators.ts';

await install('replace', testOperators);
