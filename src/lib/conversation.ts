import type { Message } from './types'

export interface ConversationMessage extends Message {
  parts: Message[]
}

/** A runtime message is a text segment, not necessarily a new user-facing turn. */
export function groupConversationMessages(messages: Message[]): ConversationMessage[] {
  const result: ConversationMessage[] = []
  const replies = new Map<string, ConversationMessage>()
  for (const message of messages) {
    // User/system records are visible boundaries. Missing routing metadata must
    // not cause unrelated legacy messages to be merged by author or timestamp.
    if (message.role !== 'assistant') replies.clear()
    const key = message.role === 'assistant' && message.runId && message.memberId
      ? JSON.stringify([message.runId, message.memberId]) : undefined
    const reply = key ? replies.get(key) : undefined
    if (reply) {
      reply.parts.push(message)
      reply.streaming ||= message.streaming
    } else {
      const entry = { ...message, parts: [message] }
      result.push(entry)
      if (key) replies.set(key, entry)
    }
  }
  return result
}
