import { describe, expect, it } from 'vitest'
import { insertWorkspaceReference, mentionQuery, type WorkspaceEntry } from './workspace-references'
const file: WorkspaceEntry = { name: 'report "café".md', path: '/tmp/café space/report "café".md', relativePath: 'report "café".md', root: '/tmp/café space', kind: 'file' }
describe('workspace reference tokens', () => {
  it('opens at the current caret and excludes e-mail, escaped reference tokens and later prose', () => {
    expect(mentionQuery('See @src/é', 10)).toEqual({ start: 4, end: 10, query: 'src/é' })
    expect(mentionQuery('user@example.com', 16)).toBeUndefined()
    expect(mentionQuery('@"/tmp/café.md" ', 14)).toBeUndefined()
    expect(mentionQuery('Go @src next', 7)).toEqual({ start: 3, end: 7, query: 'src' })
    expect(mentionQuery('Go @src next', 12)).toBeUndefined()
  })
  it('preserves the suffix and losslessly quotes spaces, Unicode and quotes in a selected path', () => {
    const value = 'Go @é follow-up requirements'
    const query = mentionQuery(value, 5)!
    const inserted = insertWorkspaceReference(value, query, file)
    expect(inserted.value).toBe(`Go @${JSON.stringify(file.path)}  follow-up requirements`)
    const token = inserted.value.slice(4, inserted.caret).trim()
    expect(JSON.parse(token)).toBe(file.path)
    expect(mentionQuery(inserted.value, inserted.caret)).toBeUndefined()
  })
})
