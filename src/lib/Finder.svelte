<script lang="ts">
  import { goto } from '$app/navigation';
  import { tick } from 'svelte';
  import { blockCaret } from './caret.ts';
  import { rank } from './fuzzy.ts';
  import { href } from './href.ts';
  import { fadeOut, flyIn } from './motion.ts';

  // fzf over the pads under this one. Collapsed it's the field; focused, a
  // panel opens upwards around it over a checker backdrop, best match nearest
  // the field, and the field stays where it was.
  let { base, items, onclose }: { base: string; items: string[]; onclose: () => void } = $props();

  const LIMIT = 300;

  let query = $state('');
  let open = $state(false);
  let selected = $state(0);
  let list = $state<HTMLUListElement>();
  let input = $state<HTMLInputElement>();

  const matches = $derived(rank(items, query.trim()));
  const shown = $derived(matches.slice(0, LIMIT));
  // What enter makes when nothing matches: the query as a path under this pad.
  const newPath = $derived(query.split('/').filter(Boolean).join('/'));

  $effect(() => {
    void query;
    selected = 0;
  });

  const go = (rel: string) => goto(href([...base.split('/'), ...rel.split('/')]));

  function close() {
    query = '';
    onclose();
  }

  async function move(by: number) {
    if (!shown.length) return;
    selected = (selected + by + shown.length) % shown.length;
    await tick();
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  function onkeydown(e: KeyboardEvent) {
    const key = (e.ctrlKey ? 'ctrl+' : '') + e.key;
    if (['ArrowUp', 'ctrl+k', 'ctrl+p'].includes(key)) move(1);
    else if (['ArrowDown', 'ctrl+j', 'ctrl+n'].includes(key)) move(-1);
    else if (key === 'ctrl+Enter') {
      if (newPath) go(newPath);
    } else if (key === 'Enter') {
      if (shown.length) go(shown[selected].item);
      else if (newPath) go(newPath);
    } else if (key === 'Escape' || key === 'ctrl+/') close();
    else return;
    e.preventDefault();
  }

  // ctrl+/ from anywhere opens it; in the field it closes it again.
  function onwindowkeydown(e: KeyboardEvent) {
    if (!e.ctrlKey || e.key !== '/' || e.defaultPrevented) return;
    e.preventDefault();
    input?.focus();
  }
</script>

<svelte:window onkeydown={onwindowkeydown} />

{#snippet highlighted(item: string, hits: number[])}
  {#each item as ch, i (i)}{#if hits.includes(i)}<span class="underline">{ch}</span
      >{:else}{ch}{/if}{/each}
{/snippet}

{#if open}
  <button
    class="fixed inset-0 z-40 checker"
    aria-label="close"
    tabindex="-1"
    onclick={close}
    out:fadeOut
  ></button>
{/if}

<div class="relative shrink-0 {open ? 'z-50' : ''}">
  {#if open}
    <!-- Mouse presses in here keep the focus in the field. -->
    <div
      class="absolute -inset-x-3 -bottom-3 flex flex-col gap-3 panel p-[11px]"
      role="presentation"
      in:flyIn
      out:fadeOut
      onmousedown={(e) => e.preventDefault()}
    >
      <div class="flex items-baseline gap-3 border-b border-ink pb-1">
        <h2 class="min-w-0 truncate">{base}/</h2>
        <span class="text-dim">{matches.length}/{items.length}</span>
        <span class="ml-auto hidden text-dim md:inline">↑↓ pick · ↵ open · ctrl+↵ new · esc</span>
      </div>
      {#if shown.length}
        <ul
          bind:this={list}
          id="finder-list"
          role="listbox"
          aria-label="pads under {base}"
          class="flex max-h-[60dvh] flex-col-reverse overflow-y-auto"
        >
          {#each shown as m, i (m.item)}
            <!-- The keyboard drives the list from the field (aria-activedescendant);
                 a click is the mouse's way in. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id="finder-{i}"
              role="option"
              aria-selected={i === selected}
              class="cursor-pointer border border-ink px-2 py-1 break-all pointer-coarse:py-2 {i > 0
                ? '-mb-px'
                : ''} {i === selected ? 'bg-ink text-bg' : 'text-ink hover:bg-ink3 hover:text-hi'}"
              onclick={() => go(m.item)}
            >
              {i === selected ? '►' : '›'}
              {@render highlighted(m.item, m.hits)}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="break-all text-dim">
          {#if newPath}
            ↵ new pad <span class="text-fg">{base}/{newPath}</span>
          {:else}
            nothing under here yet. type a name to make a pad.
          {/if}
        </p>
      {/if}
      <!-- Where the field sits, on top of the panel. -->
      <div class="h-8 shrink-0 pointer-coarse:h-10"></div>
    </div>
  {/if}

  <!-- The box shows the focus: the field fills it. -->
  <label
    class="relative flex h-8 items-center gap-2 border border-ink bg-bg px-2 focus-within:outline-1 focus-within:outline-offset-2 focus-within:outline-hi focus-within:outline-dotted pointer-coarse:h-10 {open
      ? ''
      : 'shadow-raised'}"
  >
    <span class="text-ink">&gt;</span>
    <input
      class="h-full w-full min-w-0 bg-transparent text-fg placeholder:text-dim focus-visible:outline-none!"
      bind:this={input}
      {@attach blockCaret}
      bind:value={query}
      onfocus={() => (open = true)}
      onblur={() => (open = false)}
      {onkeydown}
      role="combobox"
      aria-expanded={open}
      aria-controls="finder-list"
      aria-activedescendant={open && shown.length ? `finder-${selected}` : undefined}
      aria-label="find or make a pad under {base}"
      placeholder={items.length ? `${items.length} pads under here` : 'new pad'}
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
    />
  </label>
</div>
