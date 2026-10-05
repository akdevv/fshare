// One lint config for the whole repo: TypeScript everywhere, React hooks rules for the app.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', 'mobile/android/', 'mobile/ios/', 'mobile/.expo/', 'mobile/modules/*/android/build/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // the CLI talks to untyped native/USB APIs
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-require-imports': 'off', // React Native images: require('./icon.png')
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['cli/**', 'scripts/**', '*.mjs'], languageOptions: { globals: globals.node } },
  {
    files: ['mobile/**/*.{ts,tsx,js}'],
    plugins: { 'react-hooks': hooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
  { files: ['**/*.test.{ts,tsx}', 'mobile/jest.setup.ts'], languageOptions: { globals: globals.jest } },
);
