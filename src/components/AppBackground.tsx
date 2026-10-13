/** One decorative image across the full window. Foreground children never inherit opacity. */
export function AppBackground({ src }: { src?: string }) {
  if (!src) return null
  return <div className="app-background" aria-hidden="true"><img src={src} alt="" draggable={false} /></div>
}
