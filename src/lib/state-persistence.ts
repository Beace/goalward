import type { AppState, RuntimeEvent } from './types'

/** Build the persisted projection without copying historical event payloads into
 * every IPC call. Acknowledgement happens only after the native transaction commits.
 * Runtime events are immutable; deleting a task deletes its stored history.
 */
export class StatePersistence {
  private acknowledged: AppState | null = null
  private durableIds = new Map<string, Set<string>>()

  loaded(state: AppState | null) {
    this.durableIds.clear()
    this.acknowledged = state
    state?.tasks.forEach(task => this.remember(task.events))
  }

  remember(events: RuntimeEvent[]) {
    for (const event of events) {
      let ids = this.durableIds.get(event.taskId)
      if (!ids) { ids = new Set(); this.durableIds.set(event.taskId, ids) }
      ids.add(event.id)
    }
  }

  prepare(state: AppState): AppState {
    const previous = new Map(this.acknowledged?.tasks.map(task => [task.id, task]))
    return {
      ...state,
      tasks: state.tasks.map(source => {
        const { historyPending: _pending, ...task } = source
        const durable = this.durableIds.get(task.id)
        const saved = previous.get(task.id)
        if (!saved) return { ...task, events: task.events.filter(event => !durable?.has(event.id)) }
        if (saved.events === task.events) return { ...task, events: [] }
        // Live reducers retain the immutable prefix. Compare references before
        // allocating an ID set for imported/reordered snapshots.
        if (task.events.length >= saved.events.length && saved.events.every((event, index) => event === task.events[index])) {
          return { ...task, events: task.events.slice(saved.events.length).filter(event => !durable?.has(event.id)) }
        }
        const ids = new Set(saved.events.map(event => event.id))
        return { ...task, events: task.events.filter(event => !ids.has(event.id) && !durable?.has(event.id)) }
      }),
    }
  }

  committed(state: AppState) {
    this.acknowledged = state
    const ids = new Set(state.tasks.map(task => task.id))
    for (const id of this.durableIds.keys()) if (!ids.has(id)) this.durableIds.delete(id)
    state.tasks.forEach(task => this.remember(task.events))
  }
}
