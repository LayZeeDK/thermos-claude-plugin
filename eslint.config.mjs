import parser from '@typescript-eslint/parser';

import requireWindowsHide from './tools/eslint-rules/require-windows-hide.ts';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['.stryker-tmp/', 'plans/'] },
  {
    files: ['.claude/skills/**/*.{ts,mjs,js}', 'tools/**/*.{ts,mjs,js}', '*.mjs'],
    languageOptions: { parser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { thermos: { rules: { 'require-windows-hide': requireWindowsHide } } },
    rules: { 'thermos/require-windows-hide': 'error' },
  },
];
