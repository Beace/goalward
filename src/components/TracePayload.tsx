import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'
import './trace-payload.css'
import { useI18n } from '@/i18n'

const MAX_HIGHLIGHT_CHARACTERS = 120_000
const MAX_HIGHLIGHT_TOKENS = 8_000
const MAX_HIGHLIGHT_LINES = 2_000
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g

type Payload = { text: string; json: boolean }

function formatJsonText(text: string): string {
  // Validate with the parser, then format the original lexemes so IDs larger than
  // Number.MAX_SAFE_INTEGER, exponent notation and duplicate keys stay intact.
  JSON.parse(text)
  const tokens = Array.from(text.matchAll(JSON_TOKEN), match => match[0])
  const output: string[] = []
  let depth = 0
  const newLine = () => output.push('\n', '  '.repeat(depth))

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '{' || token === '[') {
      output.push(token)
      if (tokens[index + 1] === (token === '{' ? '}' : ']')) {
        output.push(tokens[++index])
      } else {
        // Extremely deep payloads remain readable as their original source,
        // without expanding a small input into millions of indentation spaces.
        if (++depth > 100) return text
        newLine()
      }
    } else if (token === '}' || token === ']') {
      depth--
      newLine()
      output.push(token)
    } else if (token === ',') {
      output.push(token)
      newLine()
    } else {
      output.push(token === ':' ? ': ' : token)
    }
  }
  return output.join('')
}

function formatPayload(value: unknown, fallback: string): Payload {
  if (typeof value === 'string') {
    try {
      return { text: formatJsonText(value), json: true }
    } catch {
      return { text: value, json: false }
    }
  }

  try {
    const text = JSON.stringify(value, null, 2)
    if (text !== undefined) return { text, json: true }
  } catch {
    // Runtime data should be JSON, but an unexpected value must not break the inspector.
  }
  try {
    return { text: String(value), json: false }
  } catch {
    return { text: fallback, json: false }
  }
}

function highlightJson(text: string): ReactNode | null {
  const lines = text.split('\n')
  if (text.length > MAX_HIGHLIGHT_CHARACTERS || lines.length > MAX_HIGHLIGHT_LINES) return null
  let tokenCount = 0
  const renderedLines: ReactNode[] = []

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const indentLength = line.length - line.trimStart().length
    const content = line.slice(indentLength)
    const tokens: ReactNode[] = []
    let position = 0

    for (const match of content.matchAll(JSON_TOKEN)) {
      if (++tokenCount > MAX_HIGHLIGHT_TOKENS) return null
      const offset = match.index
      if (offset > position) tokens.push(content.slice(position, offset))
      const token = match[0]
      const type = token[0] === '"'
        ? /^\s*:/.test(content.slice(offset + token.length)) ? 'key' : 'string'
        : token === 'null' ? 'null'
          : token === 'true' || token === 'false' ? 'boolean'
            : /^-?\d/.test(token) ? 'number' : 'punctuation'
      tokens.push(<span className={`trace-json-${type}`} key={offset}>{token}</span>)
      position = offset + token.length
    }
    if (position < content.length) tokens.push(content.slice(position))

    renderedLines.push(<Fragment key={lineIndex}>
      <span className="trace-json-line">
        {Array.from({ length: indentLength / 2 }, (_, index) => <span className="trace-json-indent" key={index}>{'  '}</span>)}
        {tokens}
      </span>
      {lineIndex < lines.length - 1 ? '\n' : null}
    </Fragment>)
  }
  return renderedLines
}

/** Read-only runtime payload, with JSON formatting and an exact plain-text fallback. */
export function TracePayload({ value }: { value: unknown }) {
  const { t } = useI18n()
  const fallback = t('无法显示此数据', 'Unable to display this data')
  const { payload, highlighted } = useMemo(() => {
    const payload = formatPayload(value, fallback)
    return { payload, highlighted: payload.json ? highlightJson(payload.text) : null }
  }, [value, fallback])

  return <pre className={`trace-payload ${payload.json ? 'trace-payload-json' : 'trace-payload-text'}`} tabIndex={0} aria-label={payload.json ? t('JSON 数据', 'JSON data') : t('文本数据', 'Text data')}>
    <code>{highlighted ?? payload.text}</code>
  </pre>
}
