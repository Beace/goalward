import { getTraceEntries } from './trace-events'
import type { Run, RunMember, Task } from './types'

export interface RuntimeCapabilities { steer: boolean; followUp: boolean; approvals: boolean }
const unavailable: RuntimeCapabilities = { steer: false, followUp: false, approvals: false }

/** Capabilities belong to the actual connection for this Run, never to a vendor
 * name or a different member's earlier connection. Unknown stays unavailable. */
export function getRuntimeCapabilities(task: Task, run: Run, member: RunMember): RuntimeCapabilities {
  let capabilities = unavailable
  const events = task.events.filter(event => event.runId === run.id && event.memberId === member.id)
  for (const event of getTraceEntries({ ...task, events })) {
    if (event.kind !== 'stdout') continue
    try {
      const frame = JSON.parse(event.text)
      if (frame?.type === 'runtime.capabilities') {
        const data = frame.capabilities ?? frame
        capabilities = { steer: data.steer === true, followUp: data.followUp === true, approvals: data.approvals === true }
      }
    } catch { /* Non-JSON Runtime output is not a capability announcement. */ }
  }
  return capabilities
}

export function runInputTargets(task: Task, recipient: string): Array<{ run: Run; member: RunMember; capabilities: RuntimeCapabilities }> {
  const active = task.runs.flatMap(run => run.members.filter(member => member.status === 'running' && (recipient === 'all' || member.id === recipient)).map(member => ({ run, member, capabilities: getRuntimeCapabilities(task, run, member) })))
  return active
}
export function canAppendRunInput(task: Task, recipient: string): boolean {
  const targets = runInputTargets(task, recipient)
  return targets.length > 0 && targets.every(({ capabilities }) => capabilities.steer || capabilities.followUp)
}
export function queuedRunInput(task: Task, recipient: string): boolean {
  return runInputTargets(task, recipient).some(({ capabilities }) => !capabilities.steer && capabilities.followUp)
}
