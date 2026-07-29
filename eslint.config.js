import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/dist-cloudflare/**',
      'coverage/**',
      'apps/*/dist/**',
      'packages/*/dist/**',
      'apps/api/src/generated/prisma-cloudflare/**',
      'apps/api/src/generated/prisma-supabase-edge/**',
      'design-prototypes/**',
      'qa-artifacts/**',
      '.wrangler/**',
      '.deploy/**',
      '.secrets/**',
      'supabase/.branches/**',
      'supabase/.temp/**',
      'supabase/functions/.deno/**',
      'supabase/functions/**/bundle.mjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module'
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
        sourceType: 'module'
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
