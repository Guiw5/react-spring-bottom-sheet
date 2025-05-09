//
// In order to greatly reduce complexity this component is designed to always transition to open on mount, and then
// transition to a closed state later. This ensures that all memory used to keep track of animation and gesture state
// can be reclaimed after the sheet is closed and then unmounted.
// It also ensures that when transitioning to open on mount the state is always clean, not affected by previous states that could
// cause race conditions.

import { useMachine } from '@xstate/react'
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { animated, config } from 'react-spring'
import { rubberbandIfOutOfBounds, useDrag } from 'react-use-gesture'
import {
  useAriaHider,
  useFocusTrap,
  useLayoutEffect,
  useReady,
  useReducedMotion,
  useScrollLock,
  useSnapPoints,
  useSpring,
  useSpringInterpolations,
} from './hooks'
import { overlayMachine } from './machines/overlay'
import type {
  defaultSnapProps,
  Props,
  RefHandles,
  ResizeSource,
  SnapPointProps,
} from './types'
import { fromPromise } from 'xstate'

const { tension, friction } = config.default

// @TODO implement AbortController to deal with race conditions

// @TODO rename to SpringBottomSheet and allow userland to import it directly, for those who want maximum control and minimal bundlesize
export const BottomSheet = React.forwardRef<
  RefHandles,
  {
    initialState: 'OPEN' | 'CLOSED'
    lastSnapRef: React.MutableRefObject<number | null>
  } & Props
>(function BottomSheetInternal(
  {
    children,
    sibling,
    className,
    footer,
    header,
    open: _open,
    initialState,
    lastSnapRef,
    initialFocusRef,
    onDismiss,
    maxHeight: controlledMaxHeight,
    defaultSnap: getDefaultSnap = _defaultSnap,
    snapPoints: getSnapPoints = _snapPoints,
    blocking = true,
    scrollerRef,
    scrollLocking = true,
    style,
    springConfig,
    onSpringStart,
    onSpringCancel,
    onSpringEnd,
    reserveScrollBarGap = blocking,
    expandOnContentDrag = false,
    ...props
  },
  forwardRef
) {
  // Before any animations can start we need to measure a few things, like the viewport and the dimensions of content, and header + footer if they exist
  // @TODO make ready its own state perhaps, before open or closed
  const { ready, registerReady } = useReady()

  // Controls the drag handler, used by spring operations that happen outside the render loop in React
  const canDragRef = useRef(false)

  // This way apps don't have to remember to wrap their callbacks in useCallback to avoid breaking the sheet
  const onSpringStartRef = useRef(onSpringStart)
  const onSpringCancelRef = useRef(onSpringCancel)
  const onSpringEndRef = useRef(onSpringEnd)
  useEffect(() => {
    onSpringStartRef.current = onSpringStart
    onSpringCancelRef.current = onSpringCancel
    onSpringEndRef.current = onSpringEnd
  }, [onSpringCancel, onSpringStart, onSpringEnd])

  // Behold, the engine of it all!
  const [spring, set] = useSpring()

  const defaultScrollerRef = useRef<HTMLDivElement>(null)
  const scrollRef = scrollerRef ?? defaultScrollerRef
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

  // Keeps track of the current height, or the height transitioning to
  const heightRef = useRef(0)
  const resizeSourceRef = useRef<ResizeSource>()
  const preventScrollingRef = useRef(false)

  const prefersReducedMotion = useReducedMotion()

  // "Plugins" huhuhu
  const scrollLockRef = useScrollLock({
    targetRef: scrollRef,
    enabled: ready && scrollLocking,
    reserveScrollBarGap,
  })
  const ariaHiderRef = useAriaHider({
    targetRef: containerRef,
    enabled: ready && blocking,
  })
  const focusTrapRef = useFocusTrap({
    targetRef: containerRef,
    fallbackRef: overlayRef,
    initialFocusRef: initialFocusRef || undefined,
    enabled: ready && blocking && initialFocusRef !== false,
  })

  const { minSnap, maxSnap, maxHeight, findSnap } = useSnapPoints({
    contentRef,
    controlledMaxHeight,
    footerEnabled: !!footer,
    footerRef,
    getSnapPoints,
    headerEnabled: header !== false,
    headerRef,
    heightRef,
    lastSnapRef,
    ready,
    registerReady,
    resizeSourceRef,
  })

  // Setup refs that are used in cases where full control is needed over when a side effect is executed
  const maxHeightRef = useRef(maxHeight)
  const minSnapRef = useRef(minSnap)
  const maxSnapRef = useRef(maxSnap)
  const findSnapRef = useRef(findSnap)
  const defaultSnapRef = useRef(0)
  // Sync the refs with current state, giving the spring full control over when to respond to changes
  useLayoutEffect(() => {
    maxHeightRef.current = maxHeight
    maxSnapRef.current = maxSnap
    minSnapRef.current = minSnap
    findSnapRef.current = findSnap
    defaultSnapRef.current = findSnap(getDefaultSnap)
  }, [findSnap, getDefaultSnap, maxHeight, maxSnap, minSnap])

  // New utility for using events safely
  const asyncSet = useCallback<typeof set>(
    // @ts-expect-error
    ({ onRest, config: { velocity = 1, ...config } = {}, ...opts }) =>
      new Promise((resolve) =>
        set({
          ...opts,
          config: {
            velocity,
            ...config,
            // @see https://springs.pomb.us
            mass: 1,
            // "stiffness"
            duration: 115,
            tension,
            // "damping"
            friction: Math.max(
              friction,
              friction + (friction - friction * velocity)
            ),
            ...springConfig,
          },
          onRest: (...args) => {
            resolve(...args)
            onRest?.(...args)
          },
        })
      ),
    [set]
  )
  const [current, send] = useMachine(
    overlayMachine.provide({
      actions: {
        onOpenCancel: useCallback(
          () => onSpringCancelRef.current?.({ type: 'OPEN' }),
          []
        ),
        onSnapCancel: useCallback(
          (state) =>
            onSpringCancelRef.current?.({
              type: 'SNAP',
              source: state.context.snapSource,
            }),
          []
        ),
        onCloseCancel: useCallback(
          () => onSpringCancelRef.current?.({ type: 'CLOSE' }),
          []
        ),
        onResizeCancel: useCallback(
          () =>
            onSpringCancelRef.current?.({
              type: 'RESIZE',
              source: resizeSourceRef.current,
            }),
          []
        ),
        onOpenEnd: useCallback(
          () => onSpringEndRef.current?.({ type: 'OPEN' }),
          []
        ),
        onSnapEnd: useCallback(
          (state, event) =>
            onSpringEndRef.current?.({
              type: 'SNAP',
              source: state.context.snapSource,
            }),
          []
        ),
        onResizeEnd: useCallback(
          () =>
            onSpringEndRef.current?.({
              type: 'RESIZE',
              source: resizeSourceRef.current,
            }),
          []
        ),
      },

      actors: {
        onSnapStart: fromPromise(async ({ input }) => {
          onSpringStartRef.current?.({
            type: 'SNAP',
            source: input.snapSource || 'custom',
          })
        }),
        onOpenStart: fromPromise(async (props) => {
          onSpringStartRef.current?.({ type: 'OPEN' })
          console.log('props:', props)
        }),
        onCloseStart: fromPromise(async () =>
          onSpringStartRef.current?.({ type: 'CLOSE' })
        ),
        onResizeStart: fromPromise(async () =>
          onSpringStartRef.current?.({
            type: 'RESIZE',
            source: resizeSourceRef.current,
          })
        ),
        onSnapEnd: fromPromise(async () => {
          onSpringEndRef.current?.({
            type: 'SNAP',
            source: current.context.snapSource,
          })
        }),
        onOpenEnd: fromPromise(async () =>
          onSpringEndRef.current?.({ type: 'OPEN' })
        ),
        onCloseEnd: fromPromise(async () =>
          onSpringEndRef.current?.({ type: 'CLOSE' })
        ),
        onResizeEnd: fromPromise(async () =>
          onSpringEndRef.current?.({
            type: 'RESIZE',
            source: resizeSourceRef.current,
          })
        ),
        renderVisuallyHidden: fromPromise(async () => {
          await asyncSet({
            y: defaultSnapRef.current,
            ready: 0,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            // Using defaultSnapRef instead of minSnapRef to avoid animating `height` on open
            minSnap: defaultSnapRef.current,
            immediate: true,
          })
        }),
        activate: fromPromise(async () => {
          canDragRef.current = true
          await Promise.all([
            scrollLockRef.current.activate(),
            focusTrapRef.current.activate(),
            ariaHiderRef.current.activate(),
          ])
        }),
        deactivate: fromPromise(async () => {
          scrollLockRef.current.deactivate()
          focusTrapRef.current.deactivate()
          ariaHiderRef.current.deactivate()
          canDragRef.current = false
        }),
        openImmediately: fromPromise(async () => {
          heightRef.current = defaultSnapRef.current
          await asyncSet({
            y: defaultSnapRef.current,
            ready: 1,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            // Using defaultSnapRef instead of minSnapRef to avoid animating `height` on open
            minSnap: defaultSnapRef.current,
            immediate: true,
          })
        }),
        openSmoothly: fromPromise(async () => {
          await asyncSet({
            y: 0,
            ready: 1,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            // Using defaultSnapRef instead of minSnapRef to avoid animating `height` on open
            minSnap: defaultSnapRef.current,
            immediate: true,
          })

          heightRef.current = defaultSnapRef.current

          await asyncSet({
            y: defaultSnapRef.current,
            ready: 1,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            // Using defaultSnapRef instead of minSnapRef to avoid animating `height` on open
            minSnap: defaultSnapRef.current,
            immediate: prefersReducedMotion.current,
          })
        }),
        snapSmoothly: fromPromise(async ({ input: context }) => {
          const snap = findSnapRef.current(context.y)
          heightRef.current = snap
          lastSnapRef.current = snap
          await asyncSet({
            y: snap,
            ready: 1,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            minSnap: minSnapRef.current,
            immediate: prefersReducedMotion.current,
            config: { velocity: context.velocity },
          })
        }),
        resizeSmoothly: fromPromise(async () => {
          const snap = findSnapRef.current(heightRef.current)
          heightRef.current = snap
          lastSnapRef.current = snap
          await asyncSet({
            y: snap,
            ready: 1,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            minSnap: minSnapRef.current,
            immediate:
              resizeSourceRef.current === 'element'
                ? prefersReducedMotion.current
                : true,
          })
        }),
        closeSmoothly: fromPromise(async () => {
          // Avoid animating the height property on close and stay within FLIP bounds by upping the minSnap
          asyncSet({
            minSnap: heightRef.current,
            immediate: true,
          })

          heightRef.current = 0

          await asyncSet({
            y: 0,
            maxHeight: maxHeightRef.current,
            maxSnap: maxSnapRef.current,
            immediate: prefersReducedMotion.current,
          })

          await asyncSet({ ready: 0, immediate: true })
        }),
      },
    })
  )

  useEffect(() => {
    if (!ready) return

    if (_open) {
      send({ type: 'OPEN' })
    } else {
      send({ type: 'CLOSE' })
    }
  }, [_open, send, ready])

  useLayoutEffect(() => {
    // Adjust the height whenever the snap points are changed due to resize events
    if (maxHeight || maxSnap || minSnap) {
      send({ type: 'RESIZE' })
    }
  }, [maxHeight, maxSnap, minSnap, send])

  useEffect(
    () => () => {
      // Ensure effects are cleaned up on unmount, in case they're not cleaned up otherwise
      scrollLockRef.current.deactivate()
      focusTrapRef.current.deactivate()
      ariaHiderRef.current.deactivate()
    },
    [ariaHiderRef, focusTrapRef, scrollLockRef]
  )

  useImperativeHandle(
    forwardRef,
    () => ({
      snapTo: (numberOrCallback, { velocity = 1, source = 'custom' } = {}) => {
        send({
          type: 'SNAP',
          payload: {
            y: findSnapRef.current(numberOrCallback),
            velocity,
            source,
          },
        })
      },
      get height() {
        return heightRef.current
      },
      get scrollElement() {
        return scrollRef.current
      },
    }),
    [send]
  )

  useEffect(() => {
    const elem = scrollRef.current

    const preventScrolling = (e) => {
      if (preventScrollingRef.current) {
        e.preventDefault()
      }
    }

    const preventSafariOverscroll = (e) => {
      if (elem.scrollTop < 0) {
        requestAnimationFrame(() => {
          elem.style.overflow = 'hidden'
          elem.scrollTop = 0
          elem.style.removeProperty('overflow')
        })
        e.preventDefault()
      }
    }

    if (expandOnContentDrag) {
      elem.addEventListener('scroll', preventScrolling)
      elem.addEventListener('touchmove', preventScrolling)
      elem.addEventListener('touchstart', preventSafariOverscroll)
    }
    return () => {
      elem.removeEventListener('scroll', preventScrolling)
      elem.removeEventListener('touchmove', preventScrolling)
      elem.removeEventListener('touchstart', preventSafariOverscroll)
    }
  }, [expandOnContentDrag, scrollRef])

  const handleDrag = ({
    args: [{ closeOnTap = false, isContentDragging = false } = {}] = [],
    cancel,
    direction: [, direction],
    down,
    first,
    last,
    memo = spring.y.getValue() as number,
    movement: [, _my],
    tap,
    velocity,
  }) => {
    const my = _my * -1

    // Cancel the drag operation if the canDrag state changed
    if (!canDragRef.current) {
      console.log('handleDrag cancelled dragging because canDragRef is false')
      cancel()
      return memo
    }

    if (onDismiss && closeOnTap && tap) {
      cancel()
      // Runs onDismiss in a timeout to avoid tap events on the backdrop from triggering click events on elements underneath
      setTimeout(() => onDismiss(), 0)
      return memo
    }

    // Filter out taps
    if (tap) {
      return memo
    }

    const rawY = memo + my
    const predictedDistance = my * velocity
    const predictedY = Math.max(
      minSnapRef.current,
      Math.min(maxSnapRef.current, rawY + predictedDistance * 2)
    )

    if (
      !down &&
      onDismiss &&
      direction > 0 &&
      rawY + predictedDistance < minSnapRef.current / 2
    ) {
      cancel()
      onDismiss()
      return memo
    }

    let newY = down
      ? // @TODO figure out a better way to deal with rubberband overshooting if min and max have the same value
        !onDismiss && minSnapRef.current === maxSnapRef.current
        ? rawY < minSnapRef.current
          ? rubberbandIfOutOfBounds(
              rawY,
              minSnapRef.current,
              maxSnapRef.current * 2,
              0.55
            )
          : rubberbandIfOutOfBounds(
              rawY,
              minSnapRef.current / 2,
              maxSnapRef.current,
              0.55
            )
        : rubberbandIfOutOfBounds(
            rawY,
            onDismiss ? 0 : minSnapRef.current,
            maxSnapRef.current,
            0.55
          )
      : predictedY

    if (expandOnContentDrag && isContentDragging) {
      if (newY >= maxSnapRef.current) {
        newY = maxSnapRef.current
      }

      if (memo === maxSnapRef.current && scrollRef.current.scrollTop > 0) {
        newY = maxSnapRef.current
      }

      preventScrollingRef.current = newY < maxSnapRef.current
    } else {
      preventScrollingRef.current = false
    }

    if (first) {
      send({ type: 'DRAG' })
    }

    if (last) {
      send({
        type: 'SNAP',
        payload: {
          y: newY,
          velocity: velocity > 0.05 ? velocity : 1,
          source: 'dragging',
        },
      })

      return memo
    }

    // @TODO too many rerenders
    //send('DRAG', { y: newY, velocity })
    //*
    set({
      y: newY,
      ready: 1,
      maxHeight: maxHeightRef.current,
      maxSnap: maxSnapRef.current,
      minSnap: minSnapRef.current,
      immediate: true,
      config: { velocity },
    })
    // */

    return memo
  }

  const bind = useDrag(handleDrag, {
    filterTaps: true,
  })

  if (Number.isNaN(maxSnapRef.current)) {
    throw new TypeError('maxSnapRef is NaN!!')
  }
  if (Number.isNaN(minSnapRef.current)) {
    throw new TypeError('minSnapRef is NaN!!')
  }

  const interpolations = useSpringInterpolations({ spring })

  console.log('publicStates', publicStates)
  console.log('current', current)

  return (
    <animated.div
      {...props}
      data-rsbs-root
      data-rsbs-state={publicStates.find((state) => current?.value === state)}
      data-rsbs-is-blocking={blocking}
      data-rsbs-is-dismissable={!!onDismiss}
      data-rsbs-has-header={!!header}
      data-rsbs-has-footer={!!footer}
      className={className}
      ref={containerRef}
      style={{
        // spread in the interpolations yeees
        ...interpolations,
        // but allow overriding them/disabling them
        ...style,
        // Not overridable as the "focus lock with opacity 0" trick rely on it
        // @TODO the line below only fails on TS <4
        // @ts-ignore
        opacity: spring.ready,
      }}
    >
      {sibling}
      {blocking && (
        <div
          // This component needs to be placed outside bottom-sheet, as bottom-sheet uses transform and thus creates a new context
          // that clips this element to the container, not allowing it to cover the full page.
          key="backdrop"
          data-rsbs-backdrop
          {...bind({ closeOnTap: true })}
        />
      )}
      <div
        key="overlay"
        aria-modal="true"
        role="dialog"
        data-rsbs-overlay
        tabIndex={-1}
        ref={overlayRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Always stop propagation, to avoid weirdness for bottom sheets inside other bottom sheets
            event.stopPropagation()
            if (onDismiss) onDismiss()
          }
        }}
      >
        {header !== false && (
          <div key="header" data-rsbs-header ref={headerRef} {...bind()}>
            {header}
          </div>
        )}
        <div
          id="scroll"
          key="scroll"
          data-rsbs-scroll
          ref={scrollRef}
          {...(expandOnContentDrag ? bind({ isContentDragging: true }) : {})}
        >
          <div data-rsbs-content ref={contentRef}>
            {children}
          </div>
        </div>
        {footer && (
          <div key="footer" ref={footerRef} data-rsbs-footer {...bind()}>
            {footer}
          </div>
        )}
      </div>
    </animated.div>
  )
})

// Used for the data attribute, list over states available to CSS selectors
const publicStates = [
  'closed',
  'opening',
  'open',
  'closing',
  'dragging',
  'snapping',
  'resizing',
]

// Default prop values that are callbacks, and it's nice to save some memory and reuse their instances since they're pure
function _defaultSnap({ snapPoints, lastSnap }: defaultSnapProps) {
  return lastSnap ?? Math.min(...snapPoints)
}
function _snapPoints({ minHeight }: SnapPointProps) {
  return minHeight
}
