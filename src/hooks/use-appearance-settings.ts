import { useCallback, useRef, useState } from 'react'
import { appearanceKeys, appearancePreferences, type AppearancePatch, type AppearancePreferences } from '@/lib/appearance'
import type { AppState, Settings } from '@/lib/types'

type Update = (change: (state: AppState) => AppState) => Promise<void>

/** Lives in App: changing pages never cancels an appearance write. */
export function useAppearanceSettings(settings: Settings | undefined, update: Update) {
  const confirmed = useRef<AppearancePreferences | undefined>(undefined)
  if (settings && !confirmed.current) confirmed.current = appearancePreferences(settings)
  const generation = useRef(0)
  const latest = useRef<Partial<Record<typeof appearanceKeys[number], number>>>({})
  const committed = useRef<Partial<Record<typeof appearanceKeys[number], number>>>({})
  const lastWrite = useRef<Promise<void> | undefined>(undefined)
  const [pending, setPending] = useState(0)

  const saveAppearance = useCallback((patch: AppearancePatch): Promise<void> => {
    const request = ++generation.current
    let changed: (typeof appearanceKeys[number])[] = []
    const write = update(state => {
      confirmed.current ??= appearancePreferences(state.settings)
      changed = appearanceKeys.filter(key => Object.hasOwn(patch, key) && state.settings[key] !== patch[key])
      if (!changed.length) return state
      const appearance = appearancePreferences(state.settings)
      for (const key of changed) {
        latest.current[key] = request
        Object.assign(appearance, { [key]: patch[key] })
      }
      return { ...state, settings: { ...state.settings, ...appearance } }
    })
    if (!changed.length) return lastWrite.current ?? write
    setPending(count => count + 1)
    const result = write.then(() => {
      for (const key of changed) {
        if (request >= (committed.current[key] ?? 0)) {
          committed.current[key] = request
          Object.assign(confirmed.current!, { [key]: patch[key] })
        }
      }
    }).catch(async error => {
      // Roll back only failed fields still owned by this request. A later
      // choice, another setting or a streaming task must survive older failures.
      await update(state => {
        const failed = changed.filter(key => latest.current[key] === request && state.settings[key] === patch[key])
        if (!failed.length) return state
        const appearance = appearancePreferences(state.settings)
        for (const key of failed) Object.assign(appearance, { [key]: confirmed.current![key] })
        return { ...state, settings: { ...state.settings, ...appearance } }
      }).catch(() => {})
      throw error
    }).finally(() => {
      setPending(count => count - 1)
      if (lastWrite.current === result) lastWrite.current = undefined
    })
    lastWrite.current = result
    return result
  }, [update])

  return { saveAppearance, appearanceSaving: pending > 0 }
}
