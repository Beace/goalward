// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Collapsible, CollapsibleContent, CollapsibleIndicator, CollapsibleTrigger } from './collapsible'

let reduced = false
let media: EventTarget
beforeEach(() => {
  reduced = false
  media = new EventTarget()
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: media.addEventListener.bind(media),
    removeEventListener: media.removeEventListener.bind(media),
    addListener: (callback: EventListener) => media.addEventListener('change', callback),
    removeListener: (callback: EventListener) => media.removeEventListener('change', callback),
  }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = this.dataset.slot === 'collapsible-measure' ? 120 : 0
    return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: height, width: 200, height, toJSON: () => ({}) }
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function Disclosure({ open, defaultOpen, onOpenChange, text = 'Details', disabled = false }: {
  open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; text?: string; disabled?: boolean
}) {
  return <Collapsible open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} disabled={disabled}>
    <CollapsibleTrigger><CollapsibleIndicator size={14} />Toggle details</CollapsibleTrigger>
    <CollapsibleContent role="region" aria-label="Details"><p>{text}</p><input aria-label="Draft" /></CollapsibleContent>
  </Collapsible>
}
function content(container: HTMLElement) { return container.querySelector<HTMLElement>('[data-slot="collapsible-content"]')! }

describe('shared disclosure motion and accessibility', () => {
  it('releases opted-in details only after exit, supports reversal and restores focus', async () => {
    const disclosure = (open: boolean) => <Collapsible open={open}>
      <CollapsibleTrigger>On-demand details</CollapsibleTrigger>
      <CollapsibleContent unmountOnExit><input aria-label="Temporary details" /></CollapsibleContent>
    </Collapsible>
    const view = render(disclosure(false))
    expect(screen.queryByLabelText('Temporary details')).toBeNull()
    view.rerender(disclosure(true))
    const input = screen.getByLabelText('Temporary details')
    await waitFor(() => expect(content(view.container).dataset.collapsibleMotion).toBe('idle'))
    input.focus()
    view.rerender(disclosure(false))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'On-demand details' }))
    expect(content(view.container).hidden).toBe(false)
    expect(screen.getByLabelText('Temporary details')).toBe(input)
    view.rerender(disclosure(true))
    expect(screen.getByLabelText('Temporary details')).toBe(input)
    await waitFor(() => expect(content(view.container).dataset.collapsibleMotion).toBe('idle'))
    view.rerender(disclosure(false))
    await waitFor(() => expect(screen.queryByLabelText('Temporary details')).toBeNull())
    view.rerender(disclosure(true))
    expect(screen.getByLabelText('Temporary details')).not.toBe(input)
    act(() => { reduced = true; media.dispatchEvent(new Event('change')) })
    view.rerender(disclosure(false))
    expect(screen.queryByLabelText('Temporary details')).toBeNull()
  })
  it('mounts closed details lazily and preserves their state through close and reopen', async () => {
    const view = render(<Disclosure />)
    const trigger = screen.getByRole('button', { name: 'Toggle details' })
    expect(screen.queryByLabelText('Draft')).toBeNull()
    expect(content(view.container).hidden).toBe(true)
    fireEvent.click(trigger)
    const input = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(input, { target: { value: 'Retain input' } })
    expect(trigger.getAttribute('aria-controls')).toBe(content(view.container).id)
    expect(content(view.container).dataset.collapsibleMotion).toBe('animating')
    await waitFor(() => expect(content(view.container).dataset.collapsibleMotion).toBe('idle'))

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Details' })).toBeNull()
    expect(content(view.container).getAttribute('inert')).toBe('')
    // The exiting content remains painted while already out of the focus/AT tree.
    expect(content(view.container).hidden).toBe(false)
    await waitFor(() => expect(content(view.container).hidden).toBe(true))
    fireEvent.click(trigger)
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input)
    expect((input as HTMLInputElement).value).toBe('Retain input')
  })

  it('keeps controlled activation immediate and restores child focus on an external close', async () => {
    const onOpenChange = vi.fn()
    const view = render(<Disclosure open={false} onOpenChange={onOpenChange} />)
    const trigger = screen.getByRole('button', { name: 'Toggle details' })
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    view.rerender(<Disclosure open onOpenChange={onOpenChange} />)
    screen.getByRole('textbox', { name: 'Draft' }).focus()
    view.rerender(<Disclosure open={false} onOpenChange={onOpenChange} />)
    expect(document.activeElement).toBe(trigger)
    expect(content(view.container).getAttribute('aria-hidden')).toBe('true')
    expect(content(view.container).hasAttribute('inert')).toBe(true)
  })

  it('shows default-open details without an entrance and leaves streaming updates at natural height', () => {
    const view = render(<Disclosure defaultOpen />)
    const region = screen.getByRole('region', { name: 'Details' })
    const input = screen.getByRole('textbox', { name: 'Draft' })
    expect(region.dataset.collapsibleMotion).toBe('idle')
    expect((region.firstElementChild as HTMLElement).style.height).toBe('auto')
    view.rerender(<Disclosure defaultOpen text="New streaming content" />)
    expect(screen.getByText('New streaming content')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(input)
    expect(region.dataset.collapsibleMotion).toBe('idle')
    expect((region.firstElementChild as HTMLElement).style.height).toBe('auto')
  })

  it('settles active motion when the system preference changes and keeps static toggles fully hidden', async () => {
    const view = render(<Disclosure />)
    const trigger = screen.getByRole('button', { name: 'Toggle details' })
    fireEvent.click(trigger)
    expect(content(view.container).dataset.collapsibleMotion).toBe('animating')
    act(() => { reduced = true; media.dispatchEvent(new Event('change')) })
    expect(content(view.container).dataset.collapsibleMotion).toBe('idle')
    expect((content(view.container).firstElementChild as HTMLElement).style.height).toBe('auto')
    fireEvent.click(trigger)
    expect(content(view.container).dataset.collapsibleMotion).toBe('idle')
    expect(content(view.container).hidden).toBe(true)
    fireEvent.click(trigger)
    expect(content(view.container).dataset.collapsibleMotion).toBe('idle')
    expect(content(view.container).hidden).toBe(false)
    expect(screen.getByRole('region', { name: 'Details' })).toBeTruthy()
  })

  it('preserves Radix disabled trigger semantics', () => {
    const onOpenChange = vi.fn()
    const view = render(<Disclosure disabled onOpenChange={onOpenChange} />)
    const trigger = screen.getByRole('button', { name: 'Toggle details' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(content(view.container).hidden).toBe(true)
  })
})
