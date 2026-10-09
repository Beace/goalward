import type { Transition } from 'motion/react'
// apple-design: critically damped physics, current-value/velocity retargeting.
// Damping ratio = damping / (2 * sqrt(stiffness * mass)) = 1.
// This is a tuned project preset, not a conversion of Apple's response to duration.
export const quietSpring: Transition = { type: 'spring', stiffness: 400, damping: 40, mass: 1 }
export const quickFade: Transition = { duration: 0.12, ease: 'easeOut' }
// The same restrained opacity feedback for native Web Animations API surfaces.
// No movement is necessary for modal forms; reduced motion settles immediately.
export const quickFadeWAAPI: KeyframeAnimationOptions = { duration: 120, easing: 'cubic-bezier(0, 0, 0.58, 1)', fill: 'both' }
export const inspectorSizing = { default: 336, min: 280, conversationMin: 320 } as const
