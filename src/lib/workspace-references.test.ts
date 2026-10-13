import { describe, expect, it } from 'vitest'
import { insertWorkspaceReference, mentionQuery, type WorkspaceEntry } from './workspace-references'
const file: WorkspaceEntry = { name: '报告 "中文".md', path: '/tmp/项目 space/报告 "中文".md', relativePath: '报告 "中文".md', root: '/tmp/项目 space', kind: 'file' }
describe('workspace reference tokens', () => {
  it('opens at the current caret and excludes e-mail, escaped reference tokens and later prose', () => {
    expect(mentionQuery('请查看 @src/文', 10)).toEqual({ start: 4, end: 10, query: 'src/文' })
    expect(mentionQuery('user@example.com', 16)).toBeUndefined()
    expect(mentionQuery('@"/tmp/报告.md" ', 14)).toBeUndefined()
    expect(mentionQuery('查看 @src 其它文字', 7)).toEqual({ start: 3, end: 7, query: 'src' })
    expect(mentionQuery('查看 @src 其它文字', 12)).toBeUndefined()
  })
  it('preserves the suffix and losslessly quotes spaces, Chinese and quotes in a selected path', () => {
    const value = '查看 @文 后面的要求'
    const query = mentionQuery(value, 5)!
    const inserted = insertWorkspaceReference(value, query, file)
    expect(inserted.value).toBe(`查看 @${JSON.stringify(file.path)}  后面的要求`)
    const token = inserted.value.slice(4, inserted.caret).trim()
    expect(JSON.parse(token)).toBe(file.path)
    expect(mentionQuery(inserted.value, inserted.caret)).toBeUndefined()
  })
})
