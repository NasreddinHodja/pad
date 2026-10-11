<script lang="ts">
  import { fadeOut, flyIn } from './motion.ts';

  // Deleting a root: it and every pad in it, reclaimable with the password
  // for 30 days.
  let {
    root,
    remove,
    onclose
  }: {
    root: string;
    /** Saves, deletes and leaves the pad. */
    remove: () => Promise<void>;
    onclose: () => void;
  } = $props();

  let busy = $state(false);
  let problem = $state('');

  async function confirm() {
    busy = true;
    problem = '';
    try {
      await remove();
    } catch (e) {
      problem = e instanceof Error ? e.message : "couldn't delete it";
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && !busy && onclose()} />

<button
  class="fixed inset-0 z-40 checker"
  aria-label="cancel"
  tabindex="-1"
  onclick={() => !busy && onclose()}
  out:fadeOut
></button>
<div
  class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain p-3"
  role="alertdialog"
  aria-modal="true"
  aria-labelledby="delete-title"
  aria-describedby="delete-what"
>
  <div
    class="pointer-events-auto flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6"
    in:flyIn
    out:fadeOut
  >
    <h2 id="delete-title" class="break-all underline">delete /{root}?</h2>
    <p id="delete-what" class="text-dim">
      /{root} and every pad under it go, its read-only links stop working, and every browser is signed
      out. for 30 days its password reclaims all of it from /{root}; after that, or once someone
      claims /{root} anew, it's gone for good.
    </p>
    {#if problem}
      <p class="text-ink" role="alert">► {problem}</p>
    {/if}
    <div class="flex items-center gap-3">
      <button
        class="hit relative h-8 cursor-pointer border border-ink bg-ink px-3 text-bg shadow-raised enabled:hover:bg-hi enabled:active:translate-x-0.5 enabled:active:translate-y-0.5 enabled:active:shadow-sunk disabled:cursor-wait pointer-coarse:h-10"
        disabled={busy}
        onclick={confirm}
      >
        {busy ? 'deleting…' : 'delete'}
      </button>
      <button
        class="hit relative cursor-pointer text-ink hover:text-hi hover:underline"
        disabled={busy}
        onclick={onclose}
        {@attach (el) => el.focus()}>cancel</button
      >
    </div>
  </div>
</div>
