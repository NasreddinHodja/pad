import type { Attachment } from 'svelte/attachments';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/// Moves focus into the element, to what's marked `data-autofocus` or else the
/// first thing that takes it, keeps Tab cycling inside, and once the element
/// goes gives focus back to whatever had it, unless something else took it
/// since.
export const focusTrap: Attachment<HTMLElement> = (node) => {
  const previousFocus = document.activeElement as HTMLElement | null;
  (
    node.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
    node.querySelector<HTMLElement>(FOCUSABLE)
  )?.focus();

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!node.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  window.addEventListener('keydown', onKeydown);
  return () => {
    window.removeEventListener('keydown', onKeydown);
    const now = document.activeElement;
    if (!now || now === document.body || node.contains(now)) previousFocus?.focus();
  };
};
