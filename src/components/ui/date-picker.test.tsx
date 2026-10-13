// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatePicker } from './date-picker'
import { Button } from './button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog'
import { I18nProvider, useI18n } from '@/i18n'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

function dayButton(value: string, locale = 'zh-CN'): HTMLButtonElement {
  const [year, month, day] = value.split('-').map(Number)
  const key = new Date(year, month - 1, day).toLocaleDateString(locale)
  const button = document.querySelector<HTMLButtonElement>(`[data-slot="calendar"] button[data-day="${key}"]`)
  expect(button, `Calendar day ${value} should be present`).toBeTruthy()
  return button!
}

function ControlledPicker({ initial = '2028-02-28', min, max, onChange = () => {} }: {
  initial?: string; min?: string; max?: string; onChange?: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return <><DatePicker aria-label="目标日期" value={value} min={min} max={max} onValueChange={next => { onChange(next); setValue(next) }} /><output aria-label="保存的日期">{value}</output></>
}

async function expectClosed() {
  await waitFor(() => expect(document.querySelector('[data-slot="calendar"]')).toBeNull())
}

async function openPicker(trigger: HTMLElement) {
  fireEvent.click(trigger)
  await waitFor(() => expect(document.querySelector('[data-slot="calendar"]')).toBeTruthy())
}

describe('DatePicker date-only storage and calendar behavior', () => {
  it('reads an existing date, selects a leap day without changing its calendar day, and clears it', async () => {
    const onChange = vi.fn()
    render(<ControlledPicker onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: '目标日期', description: '2028年2月28日' })
    expect(trigger.textContent).toBe('2028年2月28日')
    await openPicker(trigger)
    expect(dayButton('2028-02-28').getAttribute('data-selected-single')).toBe('true')
    fireEvent.click(dayButton('2028-02-29'))
    await expectClosed()
    expect(onChange).toHaveBeenLastCalledWith('2028-02-29')
    expect(screen.getByLabelText('保存的日期').textContent).toBe('2028-02-29')
    expect(trigger.textContent).toBe('2028年2月29日')
    expect(screen.getByRole('button', { name: '目标日期', description: '2028年2月29日' })).toBe(trigger)
    await waitFor(() => expect(document.activeElement).toBe(trigger))

    await openPicker(trigger)
    fireEvent.click(screen.getByRole('button', { name: '清除日期' }))
    await expectClosed()
    expect(onChange).toHaveBeenLastCalledWith('')
    expect(screen.getByLabelText('保存的日期').textContent).toBe('')
    expect(trigger.textContent).toBe('选择日期')
  })

  it('disables dates outside the inclusive min/max range and allows each boundary', async () => {
    const onChange = vi.fn()
    render(<ControlledPicker min="2028-02-28" max="2028-02-29" onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: '目标日期' })
    await openPicker(trigger)
    expect(dayButton('2028-02-27').disabled).toBe(true)
    expect(dayButton('2028-03-01').disabled).toBe(true)
    expect(dayButton('2028-02-28').disabled).toBe(false)
    expect(dayButton('2028-02-29').disabled).toBe(false)
    fireEvent.click(dayButton('2028-02-27'))
    fireEvent.click(dayButton('2028-03-01'))
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(dayButton('2028-02-29'))
    await expectClosed()
    expect(onChange).toHaveBeenLastCalledWith('2028-02-29')
    await openPicker(trigger)
    fireEvent.click(dayButton('2028-02-28'))
    await expectClosed()
    expect(onChange).toHaveBeenLastCalledWith('2028-02-28')
  })

  it('moves focus with arrow keys and Escape closes only the calendar before the containing dialog', async () => {
    const onSubmit = vi.fn()
    function DialogPicker() {
      const [open, setOpen] = useState(false)
      return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button>编辑任务</Button></DialogTrigger><DialogContent><DialogTitle>编辑任务日期</DialogTitle><DialogDescription>修改任务的截止日期。</DialogDescription><form onSubmit={event => { event.preventDefault(); onSubmit() }}><ControlledPicker /><Button type="submit">保存</Button></form></DialogContent></Dialog>
    }
    render(<DialogPicker />)
    const opener = screen.getByRole('button', { name: '编辑任务' })
    fireEvent.click(opener)
    const trigger = await screen.findByRole('button', { name: '目标日期' })
    await openPicker(trigger)
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2028-02-28')))
    fireEvent.keyDown(dayButton('2028-02-28'), { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(dayButton('2028-02-29')))
    fireEvent.keyDown(dayButton('2028-02-29'), { key: 'Escape' })
    await expectClosed()
    expect(screen.getByRole('dialog', { name: '编辑任务日期' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(onSubmit).not.toHaveBeenCalled()

    await openPicker(trigger)
    fireEvent.click(dayButton('2028-02-29'))
    await expectClosed()
    expect(screen.getByLabelText('保存的日期').textContent).toBe('2028-02-29')
    expect(onSubmit).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    fireEvent.keyDown(trigger, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('closes when disabled and stays closed when re-enabled until the trigger is activated', async () => {
    const onChange = vi.fn()
    const view = render(<DatePicker aria-label="目标日期" value="2028-02-28" onValueChange={onChange} />)
    await openPicker(screen.getByRole('button', { name: '目标日期' }))
    expect(dayButton('2028-02-28')).toBeTruthy()
    view.rerender(<DatePicker aria-label="目标日期" value="2028-02-28" onValueChange={onChange} disabled />)
    await expectClosed()
    const trigger = screen.getByRole('button', { name: '目标日期' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(document.querySelector('[data-slot="calendar"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    view.rerender(<DatePicker aria-label="目标日期" value="2028-02-28" onValueChange={onChange} />)
    expect(document.querySelector('[data-slot="calendar"]')).toBeNull()
    await openPicker(trigger)
    expect(dayButton('2028-02-28')).toBeTruthy()
  })

  it('uses the application language for its date, calendar, and clear action without changing the stored value', async () => {
    localStorage.setItem('goalward.preview.v1', JSON.stringify({ settings: { language: 'zh' } }))
    const onChange = vi.fn()
    function LanguagePicker() {
      const { setPreference } = useI18n()
      return <><DatePicker aria-label="目标日期" value="2028-02-29" onValueChange={onChange} /><Button onClick={() => setPreference('en')}>English</Button></>
    }
    render(<I18nProvider><LanguagePicker /></I18nProvider>)
    const trigger = await screen.findByRole('button', { name: '目标日期' })
    expect(trigger.textContent).toBe('2028年2月29日')
    await openPicker(trigger)
    expect(screen.getByRole('button', { name: '清除日期' })).toBeTruthy()
    expect(dayButton('2028-02-29').getAttribute('aria-label')).toContain('2028年')
    fireEvent.keyDown(dayButton('2028-02-29'), { key: 'Escape' })
    await expectClosed()
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(trigger.textContent).toBe('February 29th, 2028')
    await openPicker(trigger)
    expect(screen.getByRole('button', { name: 'Clear date' })).toBeTruthy()
    expect(dayButton('2028-02-29', 'en-US').getAttribute('aria-label')).toContain('February 29th, 2028')
    expect(onChange).not.toHaveBeenCalled()
  })
})
