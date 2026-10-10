import type { Transition } from 'motion/react'
import type { HTMLAttributes, KeyboardEvent, PointerEvent } from 'react'
// apple-design: critically damped physics, current-value/velocity retargeting.
// Damping ratio = damping / (2 * sqrt(stiffness * mass)) = 1.
// This is a tuned project preset, not a conversion of Apple's response to duration.
export const quietSpring: Transition = { type: 'spring', stiffness: 400, damping: 40, mass: 1 }
export const quickFade: Transition = { duration: 0.12, ease: 'easeOut' }
// The same restrained opacity feedback for native Web Animations API surfaces.
// No movement is necessary for modal forms; reduced motion settles immediately.
export const quickFadeWAAPI: KeyframeAnimationOptions = { duration: 120, easing: 'cubic-bezier(0, 0, 0.58, 1)', fill: 'both' }
export const inspectorSizing = { default: 336, min: 280, conversationMin: 320 } as const

// Radix focuses menu items on pointer move; :focus-visible can still reflect the
// preceding keyboard interaction. Track the actual input before Radix changes
// focus so mouse highlights fade while keyboard highlights update immediately.
export function hoverFeedbackHandlers<T extends HTMLElement>({
  onPointerOverCapture, onPointerMoveCapture, onKeyDownCapture,
}: Pick<HTMLAttributes<T>, 'onPointerOverCapture' | 'onPointerMoveCapture' | 'onKeyDownCapture'>) {
  const markPointer = (event: PointerEvent<T>) => {
    if (event.currentTarget.dataset.hoverInput !== 'pointer') event.currentTarget.dataset.hoverInput = 'pointer'
  }
  return {
    onPointerOverCapture(event: PointerEvent<T>) {
      markPointer(event)
      onPointerOverCapture?.(event)
    },
    onPointerMoveCapture(event: PointerEvent<T>) {
      markPointer(event)
      onPointerMoveCapture?.(event)
    },
    onKeyDownCapture(event: KeyboardEvent<T>) {
      event.currentTarget.dataset.hoverInput = 'keyboard'
      // Changing transition-duration does not settle a transition already in
      // flight. Finish only the hover color feedback before keyboard navigation;
      // leave surface fades, disclosure springs and business actions untouched.
      for (const animation of event.currentTarget.getAnimations?.({ subtree: true }) ?? []) {
        if (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition &&
          /^(background-color|color|border-(top|right|bottom|left)-color|text-decoration-color)$/.test(animation.transitionProperty)) {
          animation.finish()
        }
      }
      onKeyDownCapture?.(event)
    },
  }
}
