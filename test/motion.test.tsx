import { useState } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor, fireEvent, act } from '@testing-library/react'
import { BottomSheet, presets } from '../src'
import type { SpringConfig } from '../src'

type StartCall = {
  y?: number
  ready?: number
  config?: Partial<SpringConfig>
}

const starts: StartCall[] = []

vi.mock('../src/hooks/useSpring', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/hooks/useSpring')>()
  const patched = new WeakSet<object>()
  return {
    ...original,
    useSpring: () => {
      const result = original.useSpring()
      const api = result[1]
      if (!patched.has(api)) {
        patched.add(api)
        const start = api.start.bind(api)
        api.start = ((props: StartCall) => {
          starts.push(props)
          return start(props)
        }) as typeof api.start
      }
      return result
    },
  }
})

const content = <div style={{ height: 200 }}>sheet content</div>

const sheetRoot = () => document.querySelector<HTMLElement>('[data-rsbs-root]')
const sheetState = () => sheetRoot()?.getAttribute('data-rsbs-state')
const waitForState = (state: string) =>
  waitFor(() => expect(sheetState()).toBe(state), { timeout: 4000 })

function Dismissable(props: Partial<React.ComponentProps<typeof BottomSheet>>) {
  const [open, setOpen] = useState(true)
  return (
    <BottomSheet
      open={open}
      onDismiss={() => setOpen(false)}
      header={<div>header</div>}
      {...props}
    >
      {content}
    </BottomSheet>
  )
}

function swipe(fromY: number, toY: number) {
  const header = document.querySelector('[data-rsbs-header]')!
  const pointer = { pointerId: 1, buttons: 1, clientX: 10 }
  fireEvent.pointerDown(header, { ...pointer, clientY: fromY })
  fireEvent.pointerMove(header, { ...pointer, clientY: (fromY + toY) / 2 })
  fireEvent.pointerMove(header, { ...pointer, clientY: toY })
  fireEvent.pointerUp(header, { ...pointer, buttons: 0, clientY: toY })
}

const lastStart = () => starts[starts.length - 1]

beforeEach(() => {
  starts.length = 0
})

describe('motion', () => {
  it('keeps the historical 115ms tween when no motion is given', async () => {
    const { rerender } = render(<BottomSheet open>{content}</BottomSheet>)
    await waitForState('open')
    expect(lastStart().config?.duration).toBe(115)

    rerender(<BottomSheet open={false}>{content}</BottomSheet>)
    await waitFor(() => expect(sheetRoot()).toBeNull(), { timeout: 4000 })
    expect(lastStart().config?.duration).toBe(115)
  })

  it('springConfig still applies to every transition', async () => {
    render(
      <BottomSheet open springConfig={presets.material}>
        {content}
      </BottomSheet>
    )
    await waitForState('open')
    expect(lastStart().config?.duration).toBe(presets.material.duration)
  })

  it('opens with the open config and closes with the close config', async () => {
    const { rerender } = render(
      <BottomSheet open motion={presets.sheet}>
        {content}
      </BottomSheet>
    )
    await waitForState('open')
    expect(lastStart().config?.duration).toBe(presets.sheet.open!.duration)
    expect(lastStart().config?.easing).toBe(presets.sheet.open!.easing)

    rerender(
      <BottomSheet open={false} motion={presets.sheet}>
        {content}
      </BottomSheet>
    )
    await waitFor(() => expect(sheetRoot()).toBeNull(), { timeout: 4000 })
    expect(lastStart().config?.duration).toBe(presets.sheet.close!.duration)
  })

  it('a drag release snaps with a velocity spring, not a tween', async () => {
    render(
      <BottomSheet
        open
        motion={presets.sheet}
        header={<div>header</div>}
        snapPoints={({ maxHeight }) => [250, maxHeight]}
      >
        {content}
      </BottomSheet>
    )
    await waitForState('open')
    starts.length = 0

    swipe(400, 300)
    await waitFor(() => expect(starts.length).toBeGreaterThan(0))

    const config = lastStart().config!
    expect('duration' in config).toBe(true)
    expect(config.duration).toBeUndefined()
    expect(config.tension).toBe(presets.sheet.release!.tension)
    expect(config.friction).toBe(presets.sheet.release!.friction)
    expect(Number.isFinite(config.velocity)).toBe(true)
  })

  it('a swipe down dismisses with the release spring and a downward velocity', async () => {
    render(<Dismissable motion={presets.sheet} />)
    await waitForState('open')
    starts.length = 0

    swipe(0, 400)
    await waitFor(() => expect(sheetRoot()).toBeNull(), { timeout: 4000 })

    const close = starts.find((call) => call.y === 0)!
    expect(close.config?.duration).toBeUndefined()
    expect(close.config?.tension).toBe(presets.sheet.release!.tension)
    expect(close.config!.velocity!).toBeLessThanOrEqual(0)
  })

  it('a backdrop tap closes with the close config, not the release spring', async () => {
    render(<Dismissable motion={presets.sheet} />)
    await waitForState('open')
    starts.length = 0

    const backdrop = document.querySelector('[data-rsbs-backdrop]')!
    const pointer = { pointerId: 1, buttons: 1, clientX: 10, clientY: 10 }
    fireEvent.pointerDown(backdrop, pointer)
    fireEvent.pointerUp(backdrop, { ...pointer, buttons: 0 })

    await waitFor(() => expect(sheetRoot()).toBeNull(), { timeout: 4000 })
    expect(lastStart().config?.duration).toBe(presets.sheet.close!.duration)
  })

  it('without a release config a drag keeps using the default tween', async () => {
    render(
      <BottomSheet
        open
        header={<div>header</div>}
        snapPoints={({ maxHeight }) => [250, maxHeight]}
      >
        {content}
      </BottomSheet>
    )
    await waitForState('open')
    starts.length = 0

    swipe(400, 300)
    await waitFor(() => expect(starts.length).toBeGreaterThan(0))
    expect(lastStart().config?.duration).toBe(115)
  })
})

describe('fadeContent', () => {
  const contentOpacity = () =>
    sheetRoot()?.style.getPropertyValue('--rsbs-content-opacity')
  const sliding = () =>
    waitFor(() =>
      expect(
        sheetRoot()?.style.getPropertyValue('--rsbs-overlay-translate-y')
      ).toMatch(/^[1-9]/)
    )

  it('fades the content in by default', async () => {
    render(
      <BottomSheet open springConfig={{ duration: 5000 }}>
        {content}
      </BottomSheet>
    )
    await sliding()
    expect(Number(contentOpacity())).toBeLessThan(1)
  })

  it('keeps the content opaque when disabled', async () => {
    render(
      <BottomSheet open springConfig={{ duration: 5000 }} fadeContent={false}>
        {content}
      </BottomSheet>
    )
    await sliding()
    expect(contentOpacity()).toBe('1')
  })
})

describe('reduced motion', () => {
  function preferReducedMotion() {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('reduce'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList
    )
  }

  it('fades the whole sheet in place instead of sliding it', async () => {
    preferReducedMotion()
    const { rerender } = render(
      <BottomSheet open motion={presets.sheet}>
        {content}
      </BottomSheet>
    )
    await waitForState('open')

    const open = starts.find((call) => call.ready === 1)!
    expect(open.y).toBeUndefined()
    expect(open.config?.duration).toBe(presets.sheet.reduced!.duration)

    starts.length = 0
    rerender(
      <BottomSheet open={false} motion={presets.sheet}>
        {content}
      </BottomSheet>
    )
    await waitFor(() => expect(sheetRoot()).toBeNull(), { timeout: 4000 })
    const close = starts.find((call) => call.ready === 0)!
    expect(close.y).toBeUndefined()
  })

  it('stays instant without a reduced config', async () => {
    preferReducedMotion()
    render(<BottomSheet open>{content}</BottomSheet>)
    await waitForState('open')
    act(() => {})
    expect(starts.every((call) => call.ready !== 1 || 'y' in call)).toBe(true)
  })
})
