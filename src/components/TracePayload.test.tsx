// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TracePayload } from './TracePayload'

afterEach(cleanup)

describe('TracePayload', () => {
  it('formats nested objects and arrays with two-space indentation and typed tokens', () => {
    const value = { tool: 'search', arguments: { queries: ['first', 'second'], limit: 3, active: false, cursor: null } }
    const { container } = render(<TracePayload value={JSON.stringify(value)} />)
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(value, null, 2))
    expect([...container.querySelectorAll('.trace-json-key')].map(node => node.textContent)).toEqual(['"tool"', '"arguments"', '"queries"', '"limit"', '"active"', '"cursor"'])
    expect(container.querySelector('.trace-json-string')?.textContent).toBe('"search"')
    expect(container.querySelector('.trace-json-number')?.textContent).toBe('3')
    expect(container.querySelector('.trace-json-boolean')?.textContent).toBe('false')
    expect(container.querySelector('.trace-json-null')?.textContent).toBe('null')
    expect(container.querySelectorAll('.trace-json-indent').length).toBeGreaterThan(0)
    expect(container.querySelector('pre')?.getAttribute('tabindex')).toBe('0')
  })

  it.each([null, false, 0, true, -12.5, [], {}])('preserves the JSON value %j', value => {
    const { container } = render(<TracePayload value={value} />)
    expect(container.querySelector('code')?.textContent).toBe(JSON.stringify(value, null, 2))
    expect(container.querySelector('pre')?.getAttribute('aria-label')).toBe('JSON 数据')
  })

  it.each(['null', 'false', '0', '"quoted string"', '[false,0,null]'])('recognizes JSON text %s', value => {
    const { container } = render(<TracePayload value={value} />)
    expect(container.querySelector('code')?.textContent).toBe(JSON.stringify(JSON.parse(value), null, 2))
    expect(container.querySelector('.trace-payload-json')).toBeTruthy()
  })

  it.each(['', '  tool output\n  with spacing\n', '{"incomplete":', 'undefined'])('keeps malformed or ordinary text unchanged', value => {
    const { container } = render(<TracePayload value={value} />)
    expect(container.querySelector('code')?.textContent).toBe(value)
    expect(container.querySelector('.trace-payload-text')).toBeTruthy()
  })

  it('preserves source numbers, escapes and duplicate keys instead of silently changing trace evidence', () => {
    const value = '{"id":9007199254740993,"id":1e400,"path":"\\u0061"}'
    const { container } = render(<TracePayload value={value} />)
    expect(container.querySelector('code')?.textContent).toBe('{\n  "id": 9007199254740993,\n  "id": 1e400,\n  "path": "\\u0061"\n}')
  })

  it('renders markup and escaped strings as inert text', () => {
    const value = { '<img src=x onerror="alert(1)">': '</script><script>alert(1)</script>\n"quoted"\\end' }
    const { container } = render(<TracePayload value={value} />)
    expect(container.querySelector('code')?.textContent).toBe(JSON.stringify(value, null, 2))
    expect(container.querySelector('img, script, [onerror]')).toBeNull()
    expect(container.querySelectorAll('.trace-json-key')).toHaveLength(1)
    expect(container.querySelectorAll('.trace-json-string')).toHaveLength(1)
  })

  it('keeps large payloads complete without creating thousands of highlighting elements', () => {
    const value = { output: 'line '.repeat(30_000), tail: 'end' }
    const { container } = render(<TracePayload value={value} />)
    expect(container.querySelector('code')?.textContent).toBe(JSON.stringify(value, null, 2))
    expect(container.querySelectorAll('.trace-json-line')).toHaveLength(0)
  })

  it('does not break the inspector when a non-serializable value arrives', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    const { container, rerender } = render(<TracePayload value={circular} />)
    expect(container.querySelector('code')?.textContent).toBe('[object Object]')
    rerender(<TracePayload value={0n} />)
    expect(container.querySelector('code')?.textContent).toBe('0')
  })
})
