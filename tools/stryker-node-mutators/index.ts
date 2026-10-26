// A Stryker configuration file imports this module, so that an error in the install stops the run; Stryker only warns
// when a module in `plugins` fails to load.
import { install } from './install.ts';
import { productionOperators } from './operators.ts';

await install('add', productionOperators);
