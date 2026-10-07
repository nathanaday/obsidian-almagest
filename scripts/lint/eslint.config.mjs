// Obsidian's review rules, for the plugin's code, as the community directory scan reads it.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { project: 'tsconfig.json', tsconfigRootDir: `${import.meta.dirname}/../..` } },
    rules: {
      // Product names keep their case in the UI text.
      'obsidianmd/ui/sentence-case': ['warn', { brands: [...DEFAULT_BRANDS, 'Almagest', 'Claude Code', 'Codex', 'Duet', 'iTerm2', 'WezTerm', 'Ghostty'] }],
    },
  },
]);
