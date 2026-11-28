import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'public', 'scripts', '.tools'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
