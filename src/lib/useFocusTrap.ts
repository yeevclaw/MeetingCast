import { useLayoutEffect, useRef } from "react";

const traps: HTMLElement[] = [];
const inertUsers = new Map<HTMLElement, { count: number; original: boolean }>();
const candidates = 'button, input, select, textarea, a[href], [tabindex]';

/** Protect modal keyboard focus without taking over Escape or close handling. */
export function useFocusTrap(active = true) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const available = () => Array.from(root.querySelectorAll<HTMLElement>(candidates))
      .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.getClientRects().length > 0);
    const focusFirst = () => (root.querySelector<HTMLElement>('[data-autofocus]') ?? available()[0] ?? root).focus();
    traps.push(root);
    // Inert only siblings along the ancestry, never an ancestor of the dialog.
    const background: HTMLElement[] = [];
    let branch: HTMLElement = root;
    while (branch.parentElement && branch.parentElement !== document.body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          const state = inertUsers.get(sibling) ?? { count: 0, original: sibling.inert };
          state.count++;
          inertUsers.set(sibling, state);
          background.push(sibling);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    focusFirst();
    const onKey = (event: KeyboardEvent) => {
      if (traps[traps.length - 1] !== root || event.key !== 'Tab') return;
      const items = available();
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length || index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] ?? root : items[0] ?? root).focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (traps[traps.length - 1] === root && !root.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      traps.splice(traps.lastIndexOf(root), 1);
      for (const element of background) {
        const state = inertUsers.get(element)!;
        if (--state.count === 0) {
          element.inert = state.original;
          inertUsers.delete(element);
        }
      }
      // Wait for nested dialogs to clean up and React to remove their DOM.
      queueMicrotask(() => {
        const top = traps[traps.length - 1];
        if (trigger?.isConnected && !trigger.closest('[inert]') && (!top || top.contains(trigger))) trigger.focus();
      });
    };
  }, [active]);
  return ref;
}
