<script lang="ts">
  import { onMount } from 'svelte';
  import * as api from './api.ts';
  import type { Keys } from './crypto.ts';
  import { checkPassword } from './crypto.ts';
  import type { Pad } from './export.ts';
  import { message, when } from './format.ts';
  import { LINK_LIFETIMES } from './limits.ts';
  import type { Theme } from './theme.ts';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';

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
  // How the next link is made.
  let lasts = $state<keyof typeof LINK_LIFETIMES | 'never'>('1 week');
  let once = $state(false);
  let password = $state('');

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
    problem = (password && checkPassword(password)) || '';
    if (problem) return;
    busy = 'reading…';
    try {
      const pads = await collect((done, total) => (busy = `reading ${done}/${total}…`));
      busy = 'sealing…';
      const link = await api.share(root, keys, path, pads, theme, {
        lifetime: lasts === 'never' ? null : LINK_LIFETIMES[lasts],
        once,
        password
      });
      password = '';
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

<Modal title="read-only links" {onclose}>
  <p class="text-dim">
    a link opens a copy of /{path} and every pad under it, as they are when you make it, for anyone who
    has it. later edits don't reach it. browser history, chat apps and link shorteners keep the links
    they see: a password, sent apart from the link, keeps the copy from them.
  </p>
  {#if links === null}
    <p class="text-dim">looking…</p>
  {:else if links.length}
    <ul class="flex max-h-[40dvh] flex-col overflow-y-auto overscroll-contain">
      {#each links as link, i (link.id)}
        <li class="flex items-center gap-3 border border-ink px-2 py-1 {i > 0 ? '-mt-px' : ''}">
          <span class="min-w-0 truncate text-dim"
            >› {when(link.createdAt)}{link.expiresAt === null
              ? ''
              : `, until ${when(link.expiresAt)}`}{link.once ? ', opens once' : ''}{link.password
              ? ', password'
              : ''}</span
          >
          <Button class="ml-auto" onclick={() => copy(link)}
            >{copied === link.id ? 'copied' : 'copy'}</Button
          >
          <Button onclick={() => revoke(link)}>revoke</Button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="text-dim">no links yet.</p>
  {/if}
  <fieldset class="flex flex-col gap-2 border-t border-ink pt-2">
    <legend class="pr-2 text-dim">the next link</legend>
    <label class="flex items-center justify-between gap-3">
      <span>lasts</span>
      <select
        class="h-8 border border-ink bg-bg px-2 text-fg pointer-coarse:h-10"
        bind:value={lasts}
      >
        {#each Object.keys(LINK_LIFETIMES) as name (name)}
          <option value={name}>{name}</option>
        {/each}
        <option value="never">until revoked</option>
      </select>
    </label>
    <label class="flex items-center justify-between gap-3">
      <span>opens once, then it's gone</span>
      <input type="checkbox" class="size-5 accent-ink" bind:checked={once} />
    </label>
    <label class="flex flex-col gap-1">
      <span>password, if it needs one</span>
      <input
        class="h-8 border border-ink bg-bg px-2 text-fg pointer-coarse:h-10"
        type="password"
        autocomplete="off"
        maxlength="256"
        bind:value={password}
      />
    </label>
  </fieldset>
  {#if problem}
    <p class="text-ink" role="alert">► {problem}</p>
  {/if}
  <div class="flex items-center gap-3">
    <Button variant="primary" disabled={!!busy || links === null} onclick={make} data-autofocus>
      {busy || 'new link'}
    </Button>
    <Button onclick={onclose}>close</Button>
    {#if links?.length}
      <Button class="ml-auto" onclick={revokeAll} onblur={() => (confirming = false)}
        >{confirming ? `revoke all ${links.length}?` : 'revoke all'}</Button
      >
    {/if}
  </div>
</Modal>
