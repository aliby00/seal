import js from '@eslint/js';
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
    files: ['scripts/**/*.mjs', '*.config.{ts,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Code applicatif Next : Node côté serveur, navigateur côté client.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
