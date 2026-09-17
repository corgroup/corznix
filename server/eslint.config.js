import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

// The server had no linter — `npm run lint` was `node --check` on two entry
// files, which parses those two files and nothing else. It cannot see an
// undefined variable at all, which is how a route handler declared as
// `(_req, res, next)` while its body read `req.brandId` reached production and
// threw ReferenceError on every call.
//
// Scope is deliberately narrow: the rules that catch code which is simply
// wrong, not style. Style opinions on a codebase this size would drown the
// signal, and a gate people learn to ignore is worse than no gate.
export default defineConfig([
  globalIgnores(['node_modules', 'coverage', 'uploads', 'storage']),
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      // ---- kept as ERRORS: code that is simply wrong -------------------
      // no-undef is the one that matters most here and is why this file
      // exists. Everything else in js.configs.recommended that catches a real
      // defect (no-dupe-keys, no-unreachable, use-isnan, ...) stays on too.

      // ---- downgraded: true observations, not reasons to block a deploy --
      // Unused values are noise; an underscore prefix opts a deliberate
      // placeholder out.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Redundant regex escapes — harmless, and ~200 of them across the
      // codebase. Worth tidying, not worth failing a release over.
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      // Error chaining (`{ cause }`) is a real improvement the adapters should
      // adopt deliberately, not something to bulk-apply under time pressure.
      'preserve-caught-error': 'warn',
      'no-console': 'off', // the server logs to console on purpose
    },
  },
]);
