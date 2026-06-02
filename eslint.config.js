const js = require('@eslint/js');
const tseslint = require('@typescript-eslint/eslint-plugin');

// Flat config (ESLint v9+). Ported from the former .eslintrc.json:
//   eslint:recommended + plugin:@typescript-eslint/recommended, scoped to src/*.ts.
// `@typescript-eslint/semi` was removed in typescript-eslint v8 (formatting rules
// live in @stylistic now); Prettier handles semicolons, so it is simply dropped.
module.exports = [
  {
    ignores: [
      'out/**',
      'dist/**',
      '**/*.d.ts',
      'node_modules/**',
      '.vscode-test/**',
      'coverage/**',
      '*.config.js',
      'webpack.config.js',
      'src/webview/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs['flat/recommended'],
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // typescript-eslint v8 promotes these to errors in `recommended`; v5 (the prior
      // baseline) treated `no-explicit-any` as a warning and did not flag `require()`.
      // The codebase relies on both (pervasive `any`, intentional lazy `require('solc')`),
      // so keep the original severity rather than impose a wide refactor here.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      // ESLint 10's core `recommended` newly promotes these to errors; keep them as
      // warnings for the same baseline-preserving reason as the rules above.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
];
