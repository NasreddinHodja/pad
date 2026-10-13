<script lang="ts">
  import { browser } from '$app/env';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as api from '#lib/api.ts';
  import { message, when } from '#lib/format.ts';
  import { href } from '#lib/href.ts';
  import { applyTheme, DEFAULT } from '#lib/theme.ts';
  import { under } from '#lib/tree.ts';
  import Button from '#lib/ui/Button.svelte';

  // A read-only link's copy: the pad it was made at and those under it, all
  // fetched and opened once; moving between them stays on this page. The key
  // is after the `#`, which never reaches the server, so this opens in the
  // browser only. So is where in the copy this is: `#<key>~a/b`, the `~`
  // being outside base64's alphabet.
  let shared = $state<api.Shared & { createdAt: number }>();
  let problem = $state('');
  let key = $state('');

  const root = $derived(page.params.root!);
  const id = $derived(page.params.share!);
  const fragment = $derived(browser ? page.url.hash.slice(1) : '');
  const rel = $derived.by(() => {
    const at = fragment.indexOf('~');
    if (at === -1) return '';
    try {
      return fragment
        .slice(at + 1)
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent)
        .join('/');
    } catch {
      return '';
    }
  });
  const path = $derived(shared && (rel ? `${shared.path}/${rel}` : shared.path));
  const pad = $derived(shared?.pads.find((p) => p.path === path));
  const children = $derived(
    shared && path
      ? under(
          shared.pads.map((p) => p.path),
          path
        ).filter((name) => !name.includes('/'))
      : []
  );
  // Whether `path` is in the copy at all: a pad, or one with pads under it.
  const found = $derived(!!pad || children.length > 0 || rel === '');

  /** A place in the copy, `parts` under the pad it was made at. */
  const within = (parts: string[]) =>
    `/_/${encodeURIComponent(root)}/s/${id}#${key}` +
    (parts.length ? '~' + parts.map(encodeURIComponent).join('/') : '');

  $effect(() => {
    void id;
    const hash = location.hash.slice(1).split('~')[0];
    key = hash;
    shared = undefined;
    problem = '';
    if (!hash) {
      problem = 'this link is missing its key, the part after the #';
      return;
    }
    let current = true;
    api.readShare(root, id, hash).then(
      (s) => current && (shared = s),
      (e) => current && (problem = message(e, "couldn't open the link"))
    );
    return () => (current = false);
  });

  const relParts = $derived(rel ? rel.split('/') : []);

  // A link from before the place moved after the `#`: `/s/<id>/a/b#<key>`.
  $effect(() => {
    const old = page.params.rel;
    if (old && key) goto(within(old.split('/')), { replaceState: true });
  });

  // The root's theme as it was when the link was made.
  $effect(() => {
    applyTheme(shared?.theme ?? DEFAULT);
  });
  // Back to pad's own when the page goes, not between one theme and the next.
  $effect(() => () => applyTheme(DEFAULT));
</script>

<svelte:head>
  <title>{path ? `${path} · ` : ''}read-only · pad</title>
  <meta name="robots" content="noindex" />
  <meta property="og:title" content="a read-only pad" />
</svelte:head>

<div class="mx-auto flex min-h-dvh max-w-6xl flex-col gap-3 p-3 sm:p-6">
  <header
    class="flex flex-wrap items-center gap-x-4 panel px-3 py-1 pointer-coarse:gap-y-2 pointer-coarse:py-2"
  >
    <nav
      class="flex min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto whitespace-nowrap"
      aria-label="path"
    >
      <Button href="/">pad</Button>
      {#if shared}
        <span class="px-1 text-dim">/</span>
        <!-- The pad the link was made at, then where in the copy this is. -->
        {#if relParts.length}
          <Button href={within([])}>{shared.path}</Button>
        {:else}
          <span aria-current="page">{shared.path}</span>
        {/if}
        {#each relParts as segment, i (i)}
          <span class="px-1 text-dim">/</span>
          {#if i < relParts.length - 1}
            <Button href={within(relParts.slice(0, i + 1))}>{segment}</Button>
          {:else}
            <span aria-current="page">{segment}</span>
          {/if}
        {/each}
      {/if}
    </nav>
    <span class="ml-auto text-dim">
      {shared ? `read-only, as of ${when(shared.createdAt)}` : problem ? '' : 'opening…'}
    </span>
    {#if path}
      <!-- The pad itself, for those with the password. -->
      <Button href={href(path.split('/'))}>edit</Button>
    {/if}
  </header>

  {#if problem}
    <p class="panel p-3 text-ink" role="alert">► {problem}</p>
  {:else if shared && !found}
    <p class="panel p-3 text-ink" role="alert">► there's no /{path} in this link</p>
  {:else if shared}
    {#if pad}
      <pre
        class="flex-1 panel p-3 font-sans break-words whitespace-pre-wrap text-fg">{pad.text}</pre>
    {:else}
      <p class="panel p-3 text-dim">nothing here, only the pads under it.</p>
    {/if}
    {#if children.length}
      <nav class="flex flex-col panel p-3" aria-label="pads under /{path}">
        {#each children as name, i (name)}
          <a
            class="border border-ink px-2 py-1 break-all text-ink hover:bg-ink3 hover:text-hi pointer-coarse:py-2 {i >
            0
              ? '-mt-px'
              : ''}"
            href={within([...relParts, name])}>› {name}</a
          >
        {/each}
      </nav>
    {/if}
  {/if}
</div>
