import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  prettier,
  svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'no-undef': 'off',
      // XSS (CONTRIBUTING.org): no string becomes HTML or code. Trusted Types
      // refuses these at run time, on the paths the tests reach; this, on all.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML|srcdoc)$/]',
          message: 'No HTML from strings: build nodes, or use Svelte markup.'
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(insertAdjacentHTML|setHTMLUnsafe|createContextualFragment)$/]',
          message: 'No HTML from strings: build nodes, or use Svelte markup.'
        },
        {
          selector:
            'CallExpression[callee.object.name="document"][callee.property.name=/^(write|writeln)$/]',
          message: 'No HTML from strings: build nodes, or use Svelte markup.'
        }
      ]
    }
  },
  {
    // The client benchmarks speak Chromium's DevTools protocol, whose messages are untyped JSON.
    files: ['scripts/bench/client/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser
      }
    }
  }
);
