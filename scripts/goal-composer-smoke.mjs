/** Reuse the actual App/native IPC browser harness while keeping this task's
 * screenshots and report separate from the native session acceptance evidence. */
process.env.GOAL_COMPOSER_SMOKE = '1'
process.env.NATIVE_WORKSPACE_SMOKE_RESULTS = 'test-results/goal-composer'
process.env.NATIVE_WORKSPACE_SMOKE_OUTPUT = process.env.GOAL_COMPOSER_SMOKE_OUTPUT
  ?? 'test-results/goal-composer/evidence'
await import('./native-workspace-smoke.mjs')
