<script lang="ts">
  import { onMount } from 'svelte';
  import * as api from './api.ts';
  import type { Keys } from './crypto.ts';
  import type { Pad } from './export.ts';
  import { fadeOut, flyIn } from './motion.ts';
  import type { Theme } from './theme.ts';

  // The pad's read-only links: each a copy of the pad and those under it as
  // they were when made.
  let {
    root,
    keys,
    path,
    collect,
    theme,
    onclose
  }: {
    root: string;
    keys: Keys;
    path: string;
    /** The pad and those under it, saved first. */
    collect: (progress: (done: number, total: number) => void) => Promise<Pad[]>;
    /** The root's, for the link to show the copy in. */
    theme: Theme;
    onclose: () => void;
  } = $props();

  let links = $state<api.Share[] | null>(null);
  let busy = $state('');
  let problem = $state('');
  let copied = $state('');
  // Revoking every link asks twice.
  let confirming = $state(false);

  const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
  const when = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  onMount(async () => {
    try {
      links = await api.shares(root, keys, path);
    } catch (e) {
      problem = message(e, "couldn't list the links");
      links = [];
    }
  });

  async function copy(link: api.Share) {
    try {
      await navigator.clipboard.writeText(link.url);
      copied = link.id;
    } catch {
      problem = "couldn't copy: the browser said no";
    }
  }

  async function make() {
    busy = 'reading…';
    problem = '';
    try {
      const pads = await collect((done, total) => (busy = `reading ${done}/${total}…`));
      busy = 'sealing…';
      const link = await api.share(root, keys, path, pads, theme);
      links = [...(links ?? []), link];
      await copy(link);
    } catch (e) {
      problem = message(e, "couldn't make the link");
    } finally {
      busy = '';
    }
  }

  async function revokeAll() {
    if (!confirming) return (confirming = true);
    confirming = false;
    problem = '';
    try {
      await api.revokeAll(root, keys, path);
      links = [];
    } catch (e) {
      problem = message(e, "couldn't revoke the links");
    }
  }

  async function revoke(link: api.Share) {
    problem = '';
    try {
      await api.revoke(root, link.id);
      links = (links ?? []).filter((l) => l.id !== link.id);
    } catch (e) {
      problem = message(e, "couldn't revoke the link");
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<button
  class="fixed inset-0 z-40 checker"
  aria-label="close"
  tabindex="-1"
  onclick={onclose}
  out:fadeOut
></button>
<div
  class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-y-auto overscroll-contain p-3"
  role="dialog"
  aria-modal="true"
  aria-label="read-only links"
>
  <div
    class="pointer-events-auto flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6"
    in:flyIn
    out:fadeOut
  >
    <h2 class="underline">read-only links</h2>
    <p class="text-dim">
      a link opens a copy of /{path} and every pad under it, as they are when you make it, for anyone
      who has it. later edits don't reach it.
    </p>
    {#if links === null}
      <p class="text-dim">looking…</p>
    {:else if links.length}
      <ul class="flex max-h-[40dvh] flex-col overflow-y-auto overscroll-contain">
        {#each links as link, i (link.id)}
          <li class="flex items-center gap-3 border border-ink px-2 py-1 {i > 0 ? '-mt-px' : ''}">
            <span class="min-w-0 truncate text-dim">› {when(link.createdAt)}</span>
            <button
              class="hit relative ml-auto cursor-pointer text-ink hover:text-hi hover:underline"
              onclick={() => copy(link)}>{copied === link.id ? 'copied' : 'copy'}</button
            >
            <button
              class="hit relative cursor-pointer text-ink hover:text-hi hover:underline"
              onclick={() => revoke(link)}>revoke</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-dim">no links yet.</p>
    {/if}
    {#if problem}
      <p class="text-ink" role="alert">► {problem}</p>
    {/if}
    <div class="flex items-center gap-3">
      <button
        class="hit relative h-8 cursor-pointer border border-ink bg-ink px-3 text-bg shadow-raised enabled:hover:bg-hi enabled:active:translate-x-0.5 enabled:active:translate-y-0.5 enabled:active:shadow-sunk disabled:cursor-wait pointer-coarse:h-10"
        disabled={!!busy || links === null}
        onclick={make}
        {@attach (el) => el.focus()}
      >
        {busy || 'new link'}
      </button>
      <button
        class="hit relative cursor-pointer text-ink hover:text-hi hover:underline"
        onclick={onclose}>close</button
      >
      {#if links?.length}
        <button
          class="hit relative ml-auto cursor-pointer text-ink hover:text-hi hover:underline"
          onclick={revokeAll}
          onblur={() => (confirming = false)}
          >{confirming ? `revoke all ${links.length}?` : 'revoke all'}</button
        >
      {/if}
    </div>
  </div>
</div>
