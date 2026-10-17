import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `brand/` est un projet Remotion autonome : il a son propre tsconfig,
  // ses propres dépendances et sa propre commande de vérification.
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'brand/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Scripts et configuration : contexte Node, pas navigateur.
    files: ['scripts/**/*.mjs', '*.config.{ts,mjs}', 'indexer/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Extension navigateur : scripts classiques sans build, partagés entre le
    // content script, le service worker et la popup.
    files: ['extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions },
    },
  },
  {
    // Code applicatif Next : Node côté serveur, navigateur côté client.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
);
