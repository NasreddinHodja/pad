<script lang="ts">
  import { onMount } from 'svelte';
  import * as api from './api.ts';
  import { browserLabel } from './browser-label.ts';
  import type { Keys } from './crypto.ts';
  import { day, message, when } from './format.ts';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';

  // The browsers signed in to the root: sign any of the others out. This one
  // signs out with lock.
  let { root, keys, onclose }: { root: string; keys: Keys; onclose: () => void } = $props();

  let list = $state<api.Browser[] | null>(null);
  let busy = $state('');
  let problem = $state('');

  onMount(async () => {
    try {
      list = await api.browsers(root, keys);
      // Signed in before browsers had labels: this one names itself now.
      const mine = list.find((b) => b.mine);
      if (mine && mine.label === null) {
        await api.labelBrowser(root, keys);
        mine.label = browserLabel(navigator.userAgent);
      }
    } catch (e) {
      problem = message(e, "couldn't list the browsers");
      list ??= [];
    }
  });

  async function signOut(ids: string[]) {
    busy = ids.length === 1 ? ids[0] : 'all';
    problem = '';
    try {
      for (const id of ids) {
        await api.signOut(root, id);
        list = list!.filter((b) => b.id !== id);
      }
    } catch (e) {
      problem = message(e, "couldn't sign it out");
    } finally {
      busy = '';
    }
  }

  const others = $derived((list ?? []).filter((b) => !b.mine).map((b) => b.id));
</script>

<Modal title="browsers signed in to /{root}" onclose={() => !busy && onclose()}>
  <p class="text-dim">
    each browser that unlocked /{root} and hasn't locked it or gone 30 days unused. the names are sealed
    by each browser: the server can't read them. last use is kept to the hour.
  </p>
  {#if list === null}
    <p class="text-dim">looking…</p>
  {:else if list.length}
    <ul class="flex max-h-[40dvh] flex-col overflow-y-auto overscroll-contain">
      {#each list as b, i (b.id)}
        <li class="flex items-center gap-3 border border-ink px-2 py-1 {i > 0 ? '-mt-px' : ''}">
          <span class="min-w-0 flex-1">
            <span class="block truncate {b.mine ? 'text-hi' : 'text-fg'}">
              {b.label ?? 'a browser without a name yet'}
            </span>
            <span class="block text-dim">
              {b.mine ? 'this browser' : `last used ${when(b.lastSeen)}`} · since {day(b.createdAt)}
            </span>
          </span>
          {#if !b.mine}
            <Button
              disabled={!!busy}
              onclick={() => signOut([b.id])}
              aria-label="sign out {b.label ?? 'this browser'}, last used {when(b.lastSeen)}"
            >
              {busy === b.id ? 'signing out…' : 'sign out'}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if problem}
    <p class="text-ink" role="alert">► {problem}</p>
  {/if}
  <div class="flex items-center gap-3">
    <Button variant="primary" disabled={!!busy || !others.length} onclick={() => signOut(others)}>
      {busy === 'all' ? 'signing out…' : 'sign out every other'}
    </Button>
    <Button disabled={!!busy} onclick={onclose} data-autofocus>close</Button>
  </div>
</Modal>
