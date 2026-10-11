<script lang="ts">
  import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
  import { onMount, tick, untrack } from 'svelte';
  import * as api from './api.ts';
  import { blockCaret } from './caret.ts';
  import { forgetKeys, type Keys } from './crypto.ts';
  import Delete from './Delete.svelte';
  import { collect, download, exportPads } from './export.ts';
  import Finder from './Finder.svelte';
  import Share from './Share.svelte';
  import { href } from './href.ts';
  import { fadeOut, flyIn } from './motion.ts';
  import { rememberTheme, type Theme } from './theme.ts';
  import ThemePicker from './ThemePicker.svelte';
  import { under } from './tree.ts';

  let {
    path,
    root,
    keys,
    theme,
    retheme
  }: {
    path: string;
    root: string;
    keys: Keys;
    /** The root's, which its pads all take. */
    theme: Theme;
    retheme: (theme: Theme, keep: boolean) => Promise<void>;
  } = $props();

  const SAVE_DELAY = 600;
  const POLL = 5000;
  const RETRY = 5000;

  const segments = $derived(path.split('/'));
  // One pad per editor: the page keys it on the path.
  const where = untrack(() => ({ path, root, keys }));

  let content = $state('');
  // What the server has, as far as we know; null until it's been fetched.
  let saved: string | null = null;
  let status = $state('opening…');
  let subpads = $state<string[]>([]);
  let ready = $state(false);
  let sharing = $state(false);
  let deleting = $state(false);
  let theming = $state(false);
  // Only a root is deleted outright; a pad under it, by emptying it.
  const isRoot = !where.path.includes('/');
  // The actions, behind one button on a phone.
  let menu = $state(false);
  let menuWrap = $state<HTMLDivElement>();
  let crumbs: HTMLElement;
  // How many segments after the first are folded into "…" so the path fits.
  let folded = $state(0);
  let held: ReturnType<typeof setTimeout> | undefined;
  let copied = false;
  let textarea: HTMLTextAreaElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  // False once this editor is gone: what it was waiting for has nowhere to go.
  let alive = true;

  const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

  function schedule(delay = SAVE_DELAY) {
    clearTimeout(timer);
    timer = setTimeout(save, delay);
  }

  function oninput() {
    status = 'unsaved';
    schedule();
  }

  async function save() {
    clearTimeout(timer);
    if (saved === null) return;
    if (saving) return schedule();
    if (content === saved) {
      status = 'saved';
      return;
    }
    const body = content;
    saving = true;
    status = 'saving…';
    try {
      await api.save(where.root, where.keys, where.path, body);
      saved = body;
      status = content === saved ? 'saved' : 'unsaved';
      if (content !== saved) schedule();
    } catch (e) {
      // Too big: the pad, or its root past its quota. Sending the same text
      // again can't help; the next edit saves again, and may fit.
      if (e instanceof api.Refused && e.status === 413) {
        status =
          '► ' +
          (e.message.startsWith('request failed') ? 'too big to save' : e.message) +
          ', not saved';
        return;
      }
      status = '► ' + message(e, 'save failed') + ', retrying';
      // When the server says, or every RETRY.
      schedule((e instanceof api.Refused && e.retryAfter) || RETRY);
    } finally {
      saving = false;
    }
  }

  // Someone else's last write, shown while we have nothing unsaved.
  async function refresh() {
    if (document.hidden || saving || saved === null || content !== saved) return;
    const remote = await api.load(where.root, where.keys, where.path).catch(() => null);
    if (!alive || remote === null || remote === saved || content !== saved || saving) return;
    const { selectionStart, selectionEnd } = textarea;
    content = saved = remote;
    requestAnimationFrame(() => textarea.setSelectionRange(selectionStart, selectionEnd));
  }

  async function open() {
    try {
      const [text, paths] = await Promise.all([
        api.load(where.root, where.keys, where.path),
        api.list(where.root, where.keys)
      ]);
      if (!alive) return;
      content = saved = text;
      subpads = under(paths, where.path).filter((p) => !p.includes('/'));
      status = 'saved';
      ready = true;
      requestAnimationFrame(() => {
        if (!alive) return;
        textarea.setSelectionRange(0, 0);
        textarea.focus({ preventScroll: true });
      });
    } catch (e) {
      status = '► ' + message(e, "couldn't open the pad");
    }
  }

  onMount(() => {
    open();
    const fits = new ResizeObserver(fit);
    fits.observe(crumbs);
    document.fonts.ready.then(fit);
    const poll = setInterval(refresh, POLL);
    // Encrypting takes a moment the page may not get once it unloads, so a
    // hidden tab saves straight away.
    const onVisible = () => (document.hidden ? save() : refresh());
    const onUnload = (e: BeforeUnloadEvent) => {
      if (saved !== null && content !== saved) e.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      alive = false;
      fits.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      // Moving to another pad of the root changes only the `#`, which
      // beforeNavigate doesn't see: leaving saves here.
      if (saved !== null && content !== saved) save();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('beforeunload', onUnload);
    };
  });

  let exporting = false;

  // Saves first, so the export has what's on screen.
  async function exportAll() {
    if (exporting) return;
    exporting = true;
    try {
      await save();
      if (content !== saved) return;
      const blob = await exportPads(where.root, where.keys, where.path, (done, total) => {
        status = `exporting ${done}/${total}…`;
      });
      download(blob, where.path.replaceAll('/', '-') + '.zip');
      status = 'exported';
    } catch (e) {
      status = '► ' + message(e, 'export failed');
    } finally {
      exporting = false;
    }
  }

  // Saves first: locking signs this browser out of the root and forgets its keys.
  async function lock() {
    await save();
    if (content !== saved) return;
    rememberTheme(where.root, null);
    await Promise.all([api.lock(where.root), forgetKeys(where.root)]).catch(() => {});
    goto('/');
  }

  // Saves first, so reclaiming the root gets back what's on screen. Then
  // nothing's left to save, and the page shows the claim screen.
  async function removeRoot() {
    await save();
    if (content !== saved) throw new Error("the pad isn't saved yet, try again");
    await api.remove(where.root);
    saved = null;
    rememberTheme(where.root, null);
    await forgetKeys(where.root);
    await invalidateAll();
  }

  const actions = $derived([
    { label: 'share', disabled: !ready, run: () => (sharing = true) },
    { label: 'export', disabled: !ready, run: exportAll },
    ...(isRoot ? [{ label: 'theme', disabled: !ready, run: () => (theming = true) }] : []),
    { label: 'password', disabled: false, run: () => goto(href(segments, '?password')) },
    ...(isRoot ? [{ label: 'delete', disabled: !ready, run: () => (deleting = true) }] : []),
    { label: 'lock', disabled: false, run: lock }
  ]);

  // The path on one line: the first segment, "…", then as many of the last as
  // fit. A single segment too long for the row still scrolls, to its end.
  async function fit() {
    if (!alive) return;
    folded = 0;
    await tick();
    while (alive && crumbs.scrollWidth > crumbs.clientWidth && folded < segments.length - 2) {
      folded++;
      await tick();
    }
    if (alive) crumbs.scrollLeft = crumbs.scrollWidth;
  }

  // Holding the path copies all of it.
  function onpointerdown() {
    copied = false;
    held = setTimeout(async () => {
      copied = true;
      await navigator.clipboard.writeText('/' + where.path).then(
        () => (status = 'path copied'),
        () => (status = "► couldn't copy the path")
      );
    }, 500);
  }

  const letGo = () => clearTimeout(held);

  beforeNavigate(() => {
    if (saved !== null && content !== saved) save();
  });
</script>

<div class="mx-auto flex h-dvh max-w-6xl flex-col gap-3 p-3 sm:p-6">
  <header
    class="relative flex items-center gap-x-4 panel px-3 py-1 max-sm:flex-wrap pointer-coarse:py-2"
  >
    <nav
      bind:this={crumbs}
      class="flex min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto whitespace-nowrap select-none [-webkit-touch-callout:none]"
      aria-label="path"
      title="hold to copy the path"
      {onpointerdown}
      onpointerup={letGo}
      onpointerleave={letGo}
      onpointercancel={letGo}
      oncontextmenu={(e) => copied && e.preventDefault()}
      onclickcapture={(e) => {
        if (!copied) return;
        copied = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <a class="hit relative text-ink hover:text-hi hover:underline" href="/">pad</a>
      {#each segments as segment, i (i)}
        {#if i === 0 || i > folded}
          <span class="px-1 text-dim">/</span>
          {#if i < segments.length - 1}
            <a
              class="hit relative text-ink hover:text-hi hover:underline"
              href={href(segments.slice(0, i + 1))}>{segment}</a
            >
          {:else}
            <span aria-current="page">{segment}</span>
          {/if}
        {:else if i === 1}
          <span class="px-1 text-dim">/</span>
          <span class="text-dim" title={segments.slice(1, folded + 1).join('/')}>…</span>
        {/if}
      {/each}
    </nav>
    <!-- An error is too long to share the row on a phone; it goes under it. -->
    <span
      class="min-w-[8ch] shrink-0 text-right {status.startsWith('►')
        ? 'text-ink max-sm:order-last max-sm:basis-full max-sm:text-left'
        : 'text-dim'}"
      aria-live="polite">{status}</span
    >
    <div class="flex gap-x-4 max-sm:hidden">
      <button
        class="hit relative cursor-pointer text-ink hover:text-hi hover:underline disabled:cursor-default disabled:opacity-40"
        disabled={!ready}
        onclick={() => (sharing = true)}>share</button
      >
      <button
        class="hit relative cursor-pointer text-ink hover:text-hi hover:underline disabled:cursor-default disabled:opacity-40"
        disabled={!ready}
        onclick={exportAll}>export</button
      >
      {#if isRoot}
        <button
          class="hit relative cursor-pointer text-ink hover:text-hi hover:underline disabled:cursor-default disabled:opacity-40"
          disabled={!ready}
          onclick={() => (theming = true)}>theme</button
        >
      {/if}
      <a
        class="hit relative text-ink hover:text-hi hover:underline"
        href={href(segments, '?password')}>password</a
      >
      {#if isRoot}
        <button
          class="hit relative cursor-pointer text-ink hover:text-hi hover:underline disabled:cursor-default disabled:opacity-40"
          disabled={!ready}
          onclick={() => (deleting = true)}>delete</button
        >
      {/if}
      <button
        class="hit relative cursor-pointer text-ink hover:text-hi hover:underline"
        onclick={lock}>lock</button
      >
    </div>
    <div bind:this={menuWrap} class="sm:hidden">
      <button
        class="hit relative cursor-pointer text-ink hover:text-hi hover:underline"
        aria-expanded={menu}
        aria-controls="pad-menu"
        onclick={() => (menu = !menu)}>{menu ? '×' : '≡'}<span class="sr-only"> menu</span></button
      >
      {#if menu}
        <div
          id="pad-menu"
          class="absolute top-full right-0 z-10 mt-3 flex min-w-[20ch] flex-col panel p-3"
          in:flyIn
          out:fadeOut
        >
          {#each actions as item, i (item.label)}
            <button
              class="cursor-pointer border border-ink px-2 py-2 text-left text-ink hover:bg-ink3 hover:text-hi disabled:cursor-default disabled:opacity-40 {i >
              0
                ? '-mt-px'
                : ''}"
              disabled={item.disabled}
              onclick={() => {
                menu = false;
                item.run();
              }}>› {item.label}</button
            >
          {/each}
        </div>
      {/if}
    </div>
  </header>

  <textarea
    bind:this={textarea}
    {@attach blockCaret}
    readonly={!ready}
    bind:value={content}
    {oninput}
    onblur={save}
    class="min-h-0 flex-1 resize-none panel p-3 text-fg outline-offset-2"
    aria-label="pad"
    spellcheck="false"
    autocapitalize="off"
    placeholder="type anything. it saves itself."></textarea>

  <Finder base={path} items={subpads} onclose={() => textarea.focus()} />
</div>

<svelte:window
  onclick={(e) => {
    if (menu && !menuWrap?.contains(e.target as Node)) menu = false;
  }}
  onkeydown={(e) => {
    if (menu && e.key === 'Escape') menu = false;
  }}
/>

{#if sharing}
  <Share
    root={where.root}
    keys={where.keys}
    path={where.path}
    collect={async (progress) => {
      await save();
      if (content !== saved) throw new Error("the pad isn't saved yet, try again");
      return collect(where.root, where.keys, where.path, progress);
    }}
    {theme}
    onclose={() => {
      sharing = false;
      textarea.focus();
    }}
  />
{/if}

{#if theming}
  <ThemePicker
    {theme}
    {retheme}
    onclose={() => {
      theming = false;
      textarea.focus();
    }}
  />
{/if}

{#if deleting}
  <Delete
    root={where.root}
    remove={removeRoot}
    onclose={() => {
      deleting = false;
      textarea.focus();
    }}
  />
{/if}
