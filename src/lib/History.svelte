<script lang="ts">
  import { onMount } from 'svelte';
  import * as api from './api.ts';
  import type { Keys } from './crypto.ts';
  import { message, when } from './format.ts';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';

  // The pad's earlier texts, kept by the server as it saves: pick one to read
  // it, restore it to save it as the newest.
  let {
    root,
    keys,
    path,
    restore,
    onclose
  }: {
    root: string;
    keys: Keys;
    path: string;
    /** Saves what's on screen, then `text` over it, keeping both. */
    restore: (text: string) => Promise<void>;
    onclose: () => void;
  } = $props();

  let versions = $state<{ at: number }[] | null>(null);
  let picked = $state<{ at: number; text: string | null } | null>(null);
  let busy = $state(false);
  let problem = $state('');

  onMount(async () => {
    try {
      versions = await api.versions(root, keys, path);
    } catch (e) {
      problem = message(e, "couldn't list the versions");
      versions = [];
    }
  });

  async function pick(at: number) {
    problem = '';
    picked = { at, text: null };
    try {
      const text = await api.version(root, keys, path, at);
      if (picked?.at === at) picked = { at, text };
    } catch (e) {
      if (picked?.at === at) picked = null;
      problem = message(e, "couldn't open that version");
    }
  }

  async function confirm() {
    if (picked?.text == null) return;
    busy = true;
    problem = '';
    try {
      await restore(picked.text);
      onclose();
    } catch (e) {
      problem = message(e, "couldn't restore it");
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="history of /{path}" onclose={() => !busy && onclose()}>
  <p class="text-dim">
    earlier texts of this pad, kept as you write: one every few minutes of typing, and the last
    before each pause. restoring one saves it as the newest, and keeps what's here now among them.
  </p>
  {#if versions === null}
    <p class="text-dim">looking…</p>
  {:else if versions.length}
    <ul class="flex max-h-[25dvh] flex-col overflow-y-auto overscroll-contain">
      {#each versions as v, i (v.at)}
        <li class="flex {i > 0 ? '-mt-px' : ''}">
          <button
            class="flex-1 cursor-pointer border border-ink px-2 py-1 text-left hover:bg-ink3 hover:text-hi {picked?.at ===
            v.at
              ? 'bg-ink3 text-hi'
              : 'text-ink'}"
            aria-pressed={picked?.at === v.at}
            onclick={() => pick(v.at)}>› {when(v.at)}</button
          >
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-dim">no earlier versions yet.</p>
  {/if}
  {#if picked}
    <textarea
      class="h-[30dvh] resize-none border border-ink bg-bg p-2 text-fg"
      readonly
      aria-label="the version from {when(picked.at)}"
      value={picked.text ?? 'opening…'}></textarea>
  {/if}
  {#if problem}
    <p class="text-ink" role="alert">► {problem}</p>
  {/if}
  <div class="flex items-center gap-3">
    <Button variant="primary" disabled={busy || picked?.text == null} onclick={confirm}>
      {busy ? 'restoring…' : 'restore'}
    </Button>
    <Button disabled={busy} onclick={onclose} data-autofocus>close</Button>
  </div>
</Modal>
