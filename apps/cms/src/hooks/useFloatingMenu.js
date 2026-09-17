import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, offset, flip, shift, size, autoUpdate } from '@floating-ui/dom';

const VIEWPORT_PADDING = 14;
const HOVER_OPEN_DELAY = 200;
const HOVER_CLOSE_DELAY = 200;

/**
 * Viewport-aware floating popover behavior shared by the CMS's
 * company-switcher menus (sidebar CompanySwitcher + ComingSoon's "Switch
 * company"). Owns only interaction + positioning:
 *  - preferred `bottom-start`, auto-flips to `top-start` (then right/left)
 *    when the trigger is near a viewport edge, and shifts to stay fully
 *    on-screen (Floating UI's flip/shift/size, not hand-rolled math);
 *  - the panel is meant to be rendered through a portal with
 *    `position: fixed`, so it can never be clipped by the sidebar's own
 *    overflow/scroll and never grows the sidebar or page;
 *  - hover-intent open/close with a short delay, click-to-persist (a
 *    click stays open across a hover-leave and toggles closed on a
 *    second click), outside-click + Escape to dismiss.
 * Callers own all trigger/panel markup and content — this hook never
 * touches company data, permissions, or the menu's visual design.
 */
export function useFloatingMenu({ placement = 'bottom-start', gap = 8, maxHeight = 420, hoverIntent = true } = {}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState({ position: 'fixed', top: '-9999px', left: '-9999px', visibility: 'hidden' });
  const triggerRef = useRef(null);
  const floatingRef = useRef(null);
  const openedByClick = useRef(false);
  const closeTimer = useRef(null);
  const openTimer = useRef(null);
  const wasOpen = useRef(false);

  const clearTimers = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
  }, []);

  const close = useCallback(() => {
    clearTimers();
    openedByClick.current = false;
    setOpen(false);
  }, [clearTimers]);

  const openNow = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const toggleFromClick = useCallback(() => {
    clearTimers();
    setOpen((v) => {
      const next = !v;
      openedByClick.current = next;
      return next;
    });
  }, [clearTimers]);

  const scheduleHoverOpen = useCallback(() => {
    if (!hoverIntent || openedByClick.current) return;
    clearTimers();
    openTimer.current = setTimeout(openNow, HOVER_OPEN_DELAY);
  }, [hoverIntent, openNow, clearTimers]);

  const scheduleHoverClose = useCallback(() => {
    if (openedByClick.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, HOVER_CLOSE_DELAY);
  }, [close]);

  // Position while open, recomputed continuously via Floating UI's
  // autoUpdate (resize/scroll/content-size changes) — never a one-shot
  // calculation that goes stale.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const trigger = triggerRef.current;
    const floating = floatingRef.current;
    if (!trigger || !floating) return undefined;

    const update = () => {
      computePosition(trigger, floating, {
        placement,
        strategy: 'fixed',
        middleware: [
          offset(gap),
          flip({
            fallbackPlacements: ['top-start', 'bottom-end', 'top-end', 'right-start', 'left-start'],
            padding: VIEWPORT_PADDING,
          }),
          shift({ padding: VIEWPORT_PADDING }),
          size({
            padding: VIEWPORT_PADDING,
            apply({ availableHeight }) {
              floating.style.setProperty('--floating-max-height', `${Math.max(160, Math.min(maxHeight, availableHeight))}px`);
            },
          }),
        ],
      }).then(({ x, y }) => {
        setStyle({ position: 'fixed', top: `${y}px`, left: `${x}px`, visibility: 'visible' });
      });
    };

    return autoUpdate(trigger, floating, update);
  }, [open, placement, gap, maxHeight]);

  // Outside click + Escape close it; clicking the trigger itself is
  // handled by toggleFromClick, not this listener.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (triggerRef.current?.contains(e.target) || floatingRef.current?.contains(e.target)) return;
      close();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Focus management: move focus into the panel on open (menu-button
  // pattern — a portaled panel sits at the end of the DOM, so Tab order
  // alone would not reach it next), and return focus to the trigger on
  // close if focus was inside the panel that just unmounted.
  useEffect(() => {
    if (open && !wasOpen.current) {
      requestAnimationFrame(() => {
        floatingRef.current?.querySelector('button, [href], [tabindex]:not([tabindex="-1"])')?.focus();
      });
    }
    if (!open && wasOpen.current && document.activeElement === document.body) {
      triggerRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => clearTimers, [clearTimers]);

  return {
    open,
    style,
    triggerRef,
    floatingRef,
    triggerHandlers: {
      onClick: toggleFromClick,
      onMouseEnter: scheduleHoverOpen,
      onMouseLeave: scheduleHoverClose,
    },
    floatingHandlers: {
      onMouseEnter: clearTimers,
      onMouseLeave: scheduleHoverClose,
    },
    close,
  };
}

export default useFloatingMenu;
