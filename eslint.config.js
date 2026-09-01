// ESLint flat config (v9). Cover all Node.js helper sources in the
// repo: `.github/scripts/**`, `scripts/**`, and `src/**`. The shell
// pipeline under `.github/scripts/pipeline/` is linted via shellcheck
// separately (see AGENTS.md). The CI workflow (ci.yml) runs
// `npm run lint` against this config.
'use strict';

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    // Glob over the three source trees. `__tests__/` subdirs are
    // handled by the dedicated Jest-globals block below so the test
    // globals (describe/test/expect/jest) are recognised there.
    files: [
      '.github/scripts/**/*.js',
      'scripts/**/*.js',
      'src/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        // Node.js 24 globals (declared explicitly so we don't depend on
        // the runtime's specific version of `globals`).
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        exports: 'writable',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        // Cheerio-loaded DOM globals used in unified-downloader.js.
        document: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Jest test files under both trees share the same global vocabulary.
    files: [
      '.github/scripts/__tests__/**/*.js',
      'src/**/__tests__/**/*.js',
    ],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
];
