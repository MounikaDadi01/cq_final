import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * One database, so one file at a time.
     *
     * The isolation suites seed real rows and real storage objects in a shared
     * project. Run in parallel they interfere with each other's fixtures, and the
     * failure surfaces in whichever teardown loses the race — which reads as a
     * policy bug rather than a scheduling one. That is the worst possible way for
     * this particular suite to fail, because its whole job is to tell you
     * truthfully whether isolation holds.
     *
     * The pure-computation files lose a little wall-clock to this. Worth it: a
     * green run has to mean the policies passed, not that the ordering was lucky.
     */
    fileParallelism: false,

    /**
     * The one-off product check is opt-in, by name.
     *
     * `npm run verify` targets it directly. Excluding it here rather than gating it
     * on an env var inside the file is the stronger guarantee: it cannot fire as a
     * side effect of `npm test`, a watch run, or an editor's test explorer. It
     * writes real rows and uploads real objects, so "did not run" has to be the
     * default and "ran" has to be a decision.
     */
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.CQ_VERIFY === '1' ? [] : ['tests/product-verification.test.ts']),
    ],
  },
})
