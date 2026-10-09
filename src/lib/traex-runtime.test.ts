import { describe, expect, it } from 'vitest'
import { applyRuntimeEvent, createInitialState, createTask } from './domain'
import { migrateWorkspace } from './workspace'
import { migrateTraexRuntime } from './traex-runtime'
import { canConfigureTask } from './onboarding'
import { reusableSession } from './runtime-session'

describe('TraeX shared Codex execution', () => {
  it('upgrades saved v2 settings automatically and preserves historical snapshots and disabled choices', () => {
    const state = createInitialState()
    const legacy = { ...state.settings.runtimes[2], adapter: 'generic' as const, executable: '/custom/traex', defaultModel: 'my-model', args: [] }
    state.settings.runtimes[2] = legacy
    state.tasks[0].runs[0].members[2].runtime = structuredClone(legacy)
    const history = structuredClone(state.tasks)
    const next = migrateWorkspace(state)
    expect(next.settings.runtimes[2]).toMatchObject({ adapter: 'codex', args: [], executable: '/custom/traex', defaultModel: 'my-model' })
    expect(canConfigureTask(next.settings.runtimes[2])).toBe(true)
    expect(next.tasks).toEqual(history)
    expect(state.settings.runtimes[2].adapter).toBe('generic')
    expect(migrateWorkspace(next)).toBe(next)
    expect(migrateTraexRuntime({ ...legacy, enabled: false }).enabled).toBe(false)
    expect(migrateTraexRuntime({ ...legacy, id: 'custom-cli' }).adapter).toBe('generic')
  })

  it('removes legacy launch scaffolding while retaining user overrides and explicit permission inheritance', () => {
    const runtime = { ...createInitialState().settings.runtimes[2], adapter: 'generic' as const,
      args: ['--profile', 'exec', 'exec', '--json', '--color', 'never', '--skip-git-repo-check', '--model', '{model}', '--', '{prompt}'],
      permissions: { generic: { args: ['--sandbox', 'read-only'] } },
    }
    const next = migrateTraexRuntime(runtime)
    expect(next.args).toEqual(['--profile', 'exec', '--sandbox', 'read-only'])
    expect(next.permissions?.codex).toEqual({ sandbox: 'inherit', network: 'inherit', additionalDirectories: [] })
    expect(migrateTraexRuntime({ ...runtime, args: [], permissions: { generic: { args: [] } } }).permissions?.codex?.sandbox).toBe('inherit')
    const state = createInitialState()
    state.settings.runtimes[2] = runtime
    state.onboarding = { version: 1, completedAt: '', outcome: 'configured', managedRuntimes: [runtime] }
    const migrated = migrateWorkspace(state)
    expect(migrated.onboarding?.managedRuntimes?.[0]).toEqual(migrated.settings.runtimes[2])
  })

  it('projects JSONL replies and resumes only the TraeX member session, never the Codex member', () => {
    const state = createInitialState()
    state.settings.defaultRuntime = 'traex'
    const runtime = state.settings.runtimes[2]
    const task = createTask(state.settings, 'TraeX conversation', '/tmp/project', 'solo')
    const member = task.members[0]
    expect(member.runtimeId).toBe('traex')
    task.runs = [{ id: 'first', createdAt: task.createdAt, directory: task.directory, prompt: 'hello', members: [{ ...member, runtime, model: '', status: 'running' }] }]
    state.tasks = [task]
    const frames = [
      { type: 'thread.started', thread_id: 'traex-session' },
      { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'TraeX reply' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
    ].map(frame => JSON.stringify(frame)).join('\n') + '\n'
    const next = applyRuntimeEvent(state, { id: 'event', taskId: task.id, runId: 'first', memberId: member.id, timestamp: task.createdAt, kind: 'stdout', text: frames })
    expect(next.tasks[0].messages.some(message => message.text === 'TraeX reply')).toBe(true)
    expect(reusableSession(next.tasks[0], member, runtime)).toBe('traex-session')
    expect(reusableSession(next.tasks[0], member, state.settings.runtimes[0])).toBeUndefined()
  })
})
