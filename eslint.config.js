'use strict';
/**
 * The mechanical half of what CONTRIBUTING.md describes.
 *
 * The judgement calls - comments explaining why rather than what, settings
 * that actually do something - a linter cannot check. These are the rules that
 * catch the mistakes this codebase has actually made: an unused variable left
 * behind by a refactor, a name that only exists on one platform, a promise
 * nobody awaited.
 *
 * Flat config, no plugins, no framework preset. Adding a dependency to check
 * that we do not add dependencies would be its own joke.
 */

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', screen: 'readonly',
  location: 'readonly', localStorage: 'readonly', fetch: 'readonly', Image: 'readonly',
  Blob: 'readonly', URL: 'readonly', FileReader: 'readonly', TextEncoder: 'readonly',
  XMLSerializer: 'readonly', CSS: 'readonly', HTMLElement: 'readonly', Element: 'readonly',
  KeyboardEvent: 'readonly', Event: 'readonly', CustomEvent: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', console: 'readonly', performance: 'readonly',
  matchMedia: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly',
  AudioContext: 'readonly', webkitAudioContext: 'readonly', getComputedStyle: 'readonly',
  structuredClone: 'readonly', crypto: 'readonly', Notification: 'readonly',
  IntersectionObserver: 'readonly', ResizeObserver: 'readonly', Node: 'readonly',
  MutationObserver: 'readonly', Audio: 'readonly', Gamepad: 'readonly'
};

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', setImmediate: 'readonly', structuredClone: 'readonly',
  URL: 'readonly', TextEncoder: 'readonly', global: 'readonly', fetch: 'readonly'
};

const SHARED_RULES = {
  // Mistakes, not style.
  'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],

  // An unawaited promise is how a "why did nothing happen" bug starts.
  // The atomic-updates rule is a warning rather than an error: it is built for
  // genuinely concurrent code, and in a single-threaded renderer "assign after
  // await" is the normal shape. Worth seeing, not worth failing a build over.
  'require-atomic-updates': 'warn',
  'no-async-promise-executor': 'error',

  // An empty catch is usually deliberate here, but it should say so.
  'no-empty': ['error', { allowEmptyCatch: true }],

  // House style, only where it is unambiguous.
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'prefer-const': 'error',
  'no-var': 'error',
  // curly is deliberately absent: this codebase uses brace-less single
  // statements consistently, and the rule's autofix collapses them into
  // {return x;} on its own line, which is worse than what it replaced.
  'no-throw-literal': 'error'
};

module.exports = [
  {
    ignores: ['node_modules/**', 'release/**', 'docs/**', 'build/**']
  },
  {
    // The renderer: classic scripts, one window.BN namespace, no modules.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...BROWSER_GLOBALS, BN: 'writable' }
    },
    rules: {
      ...SHARED_RULES,
      // The renderer must not reach for Node; that is what the bridge is for.
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'The renderer talks to the main process through BN.api, not require().' },
        { name: 'process', message: 'The renderer has no process; ask the main process through BN.api.' }
      ]
    }
  },
  {
    // The main process and the scripts around it.
    files: ['electron/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS
    },
    rules: SHARED_RULES
  }
];
