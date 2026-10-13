export const defaultBackgroundImageOpacity = 100
export const defaultBackgroundSurfaceOpacity = 85

/** Percentages are bounded at the rendering boundary as well as on import. */
export function normalizeBackgroundOpacity(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback
}
