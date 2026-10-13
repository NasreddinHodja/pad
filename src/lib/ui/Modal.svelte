<script lang="ts">
  import type { Snippet } from 'svelte';
  import Backdrop from './Backdrop.svelte';
  import { focusTrap } from './focus-trap.ts';
  import { fadeOut, flyIn } from './motion.ts';

  // A titled panel centred over a backdrop. Escape or a click on the backdrop
  // calls `onclose`; Tab stays inside.
  let {
    title,
    role = 'dialog',
    describedby,
    onclose,
    children
  }: {
    title: string;
    /** `alertdialog` for one that asks before something can't be undone. */
    role?: 'dialog' | 'alertdialog';
    /** The id of what says what it's about. */
    describedby?: string;
    onclose: () => void;
    children: Snippet;
  } = $props();

  const id = $props.id();
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<Backdrop onclick={onclose} />
<div
  class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain p-3"
  {role}
  aria-modal="true"
  aria-labelledby="{id}-title"
  aria-describedby={describedby}
  {@attach focusTrap}
>
  <div
    class="pointer-events-auto flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6"
    in:flyIn
    out:fadeOut
  >
    <h2 id="{id}-title" class="break-all underline">{title}</h2>
    {@render children()}
  </div>
</div>
