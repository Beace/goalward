import { describe, expect, it } from 'vitest'
import { groupConversationMessages } from './conversation'
import { applyRuntimeEvent, createInitialState, createTask, recoverInterruptedState } from './domain'
import type { Message } from './types'

const message = (id: string, patch: Partial<Message> = {}): Message => ({ id, role: 'assistant', runId: 'run', memberId: 'member', text: id, createdAt: '2026-09-17T03:00:00Z', ...patch })
const parts = (messages: Message[]) => groupConversationMessages(messages).map(reply => reply.parts.map(part => part.id))

describe('conversation turns', () => {
  it('groups interleaved output by run and member without mutating persisted records', () => {
    const messages = [message('a'), message('b', { memberId: 'other' }), message('c', { streaming: true }), message('d', { runId: 'next' })]
    const original = structuredClone(messages)
    expect(parts(messages)).toEqual([['a', 'c'], ['b'], ['d']])
    expect(groupConversationMessages(messages)[0]).toMatchObject({ id: 'a', createdAt: messages[0].createdAt, streaming: true })
    expect(messages).toEqual(original)
  })

  it('respects user/system boundaries and does not guess missing legacy routing metadata', () => {
    const messages = [message('a'), message('user', { role: 'user' }), message('b'), message('system', { role: 'system' }), message('c'), message('d', { runId: undefined }), message('e', { runId: undefined }), message('f', { memberId: undefined })]
    expect(parts(messages)).toEqual(messages.map(item => [item.id]))
  })

  it('groups Codex paragraphs across tools, updates snapshots once, and survives reload', () => {
    const initial = createInitialState()
    const task = createTask(initial.settings, '同一轮回答', '/tmp', 'solo')
    const member = task.members[0]
    task.runs = [{ id: 'run', createdAt: task.createdAt, prompt: 'test', directory: '/tmp', members: [{ ...member, runtime: initial.settings.runtimes[0], model: '', status: 'running' }] }]
    let state = { ...initial, tasks: [task] }
    const payloads = [
      { type: 'item.completed', item: { id: 'p1', type: 'agent_message', text: '先检索新闻。' } },
      { type: 'item.completed', item: { id: 'search', type: 'web_search', query: 'AI news' } },
      { type: 'item.updated', item: { id: 'p2', type: 'agent_message', text: '整理' } },
      { type: 'item.completed', item: { id: 'p2', type: 'agent_message', text: '整理完成。' } },
    ]
    payloads.forEach((payload, index) => {
      state = applyRuntimeEvent(state, { id: String(index), taskId: task.id, runId: 'run', memberId: member.id, timestamp: task.createdAt, kind: 'stdout', text: JSON.stringify(payload) + '\n' })
    })
    for (const current of [state, recoverInterruptedState(JSON.parse(JSON.stringify(state)))]) {
      const replies = groupConversationMessages(current.tasks[0].messages)
      expect(replies).toHaveLength(1)
      expect(replies[0].parts.map(part => part.text)).toEqual(['先检索新闻。', '整理完成。'])
      expect(current.tasks[0].events).toHaveLength(4)
    }
  })
})
