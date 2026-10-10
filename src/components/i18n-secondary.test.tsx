// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileIcon } from './FileIcon'
import { MarkdownMessage } from './MarkdownMessage'
import { Status } from './Status'
import { createGoal } from '@/lib/goals'

vi.mock('@/i18n', () => ({
  useI18n: () => ({ language: 'en', t: (_zh: string, en: string) => en }),
  translate: (_zh: string, en: string) => en,
}))

describe('secondary UI in English', () => {
  it('translates status and file-type affordances', () => {
    const { container } = render(<><Status status="running" /><FileIcon name="theme.css" /></>)
    expect(screen.getByText('Running')).toBeTruthy()
    expect(container.querySelector('.file-type-icon')?.getAttribute('title')).toBe('Stylesheet')
  })

  it('translates Markdown controls without altering message content', () => {
    render(<MarkdownMessage text={'用户内容保持原样\n\n```ts\nconst value = 1\n```'} />)
    expect(screen.getByText('用户内容保持原样')).toBeTruthy()
    expect(screen.getByLabelText('ts code block')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  })

  it('creates English goal history and validation messages', () => {
    expect(() => createGoal({ title: '' })).toThrow('Describe the goal you want to pursue first.')
    const goal = createGoal({ title: 'Ship the app' }, '2026-10-10T00:00:00.000Z')
    expect(goal.currentState.reason).toBe('Established initial context')
    expect(goal.definitions[0].reason).toBe('Created goal')
  })
})
