// A Stryker configuration file that mutates test files imports this module, so that an error in the install stops the
// run. Stryker's own mutators only add noise in test code, so they make way for the test-code operators.
import { install } from './install.ts';
import { testOperators } from './operators.ts';

await install('replace', testOperators);
