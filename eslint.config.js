import { fileURLToPath, URL } from 'node:url';
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'backups/**',
      'apps/*/dist/**',
      'packages/*/dist/**',
      'design-prototypes/**',
      'qa-artifacts/**',
      '.deploy/**',
      '.secrets/**',
      '.codex-audit/**',
      '.audit/**',
      '.codex-worktrees/**',
      '.worktrees/**',
      '.runtime/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir }
    }
  },
  {
    files: ['**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
        tsconfigRootDir
      }
    }
  },
  {
    files: ['apps/admin/**/*.vue'],
    languageOptions: {
      globals: {
        ...globals.browser
      },
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
        tsconfigRootDir
      }
    },
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  },
  {
    files: ['apps/admin/**/*.{ts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    files: ['apps/admin/src/v2/features/**/components/*.vue'],
    rules: {
      'vue/no-mutating-props': ['error', { shallowOnly: true }]
    }
  },
  {
    files: ['scripts/acceptance-v2-navigation-performance.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  eslintConfigPrettier
];
