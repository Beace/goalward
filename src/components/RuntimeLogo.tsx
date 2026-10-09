import { useState } from 'react'
import { Terminal } from 'lucide-react'
import codexLogo from '@/assets/runtimes/codex.png'
import claudeLogo from '@/assets/runtimes/claude.png'
import deepseekLogo from '@/assets/runtimes/deepseek.svg'
import traeLogo from '@/assets/runtimes/trae.png'
import kimiLogo from '@/assets/runtimes/kimi.png'
import piLogo from '@/assets/runtimes/pi.svg'
import { cn } from '@/lib/utils'
import type { RuntimeConfig } from '@/lib/types'

type RuntimeIdentity = Pick<RuntimeConfig, 'id' | 'adapter'>
const logos = {
  codex: codexLogo,
  kimi: kimiLogo,
  pi: piLogo,
  claude: claudeLogo,
  'deepseek-harness': deepseekLogo,
  traex: traeLogo,
} as const
type RuntimeBrand = keyof typeof logos

export function getRuntimeBrand(runtime?: RuntimeIdentity, runtimeId?: string): RuntimeBrand | undefined {
  const id = runtime?.id ?? runtimeId
  if (id && Object.hasOwn(logos, id)) return id as RuntimeBrand
  // Explicit adapters identify custom registrations; a display name or model does not.
  if (runtime?.adapter === 'codex' || runtime?.adapter === 'claude' || runtime?.adapter === 'kimi' || runtime?.adapter === 'pi') return runtime.adapter
  return undefined
}

/** Decorative identity next to a runtime's text label. Assets are bundled for offline use. */
export function RuntimeLogo({ runtime, runtimeId, size = 16, className }: {
  runtime?: RuntimeIdentity
  runtimeId?: string
  size?: number
  className?: string
}) {
  const brand = getRuntimeBrand(runtime, runtimeId)
  const src = brand ? logos[brand] : undefined
  const [failedSrc, setFailedSrc] = useState<string>()
  const showLogo = src && failedSrc !== src
  return <span aria-hidden="true" data-runtime-logo={showLogo ? brand : 'generic'} className={cn('inline-flex shrink-0 items-center justify-center align-middle', className)} style={{ width: size, height: size }}>
    {showLogo ? <img src={src} alt="" draggable={false} width={size} height={size} className="block h-full w-full object-contain" onError={() => setFailedSrc(src)} /> : <Terminal className="size-full" />}
  </span>
}
