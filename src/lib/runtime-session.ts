import type { Member, RuntimeConfig, Task } from './types'
import { getRuntimeSessionId } from './runtime-output'

// Preserve symlink/.. semantics: uncertain paths start a new session.
const directoryKey = (path: string) => path.replace(/\/+$/, '') || '/'

/** A Run is a turn/trace boundary; the vendor session belongs to this task's member. */
export function reusableSession(task: Task, member: Member, runtime: RuntimeConfig): string | undefined {
  if (runtime.adapter === 'generic') return
  for (let index = task.runs.length - 1; index >= 0; index--) {
    const run = task.runs[index]
    const previous = run.members.find(candidate => candidate.id === member.id)
    if (!previous) continue
    if (directoryKey(run.directory) !== directoryKey(task.directory)
      || previous.runtime.id !== runtime.id || previous.runtime.adapter !== runtime.adapter
      || previous.runtime.executable !== runtime.executable
      || JSON.stringify(previous.runtime.args) !== JSON.stringify(runtime.args)) return
    // A real turn without a recorded id is a legacy/unrecoverable session.
    // Do not skip it and accidentally resume an older, incomplete context.
    return getRuntimeSessionId(task, run, previous)
  }
}
