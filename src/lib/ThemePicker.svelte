<script lang="ts">
  import { fadeOut, flyIn } from './motion.ts';
  import { PRESETS, sameTheme, type Theme } from './theme.ts';

  // The root's theme: a preset, or each colour. Every pick shows at once and is saved to the root.
  let {
    theme,
    retheme,
    onclose
  }: {
    theme: Theme;
    /** Shows `theme`; `keep` saves it to the root too. */
    retheme: (theme: Theme, keep: boolean) => Promise<void>;
    onclose: () => void;
  } = $props();

  const COLOURS: [keyof Theme, string][] = [
    ['bg', 'background'],
    ['fg', 'text'],
    ['ink', 'ink']
  ];

  let problem = $state('');

  async function pick(next: Theme, keep = true) {
    problem = '';
    await retheme(next, keep).catch((e) => {
      problem = e instanceof Error ? e.message : "couldn't save the theme";
    });
  }

  const colour = (e: Event) => (e.currentTarget as HTMLInputElement).value;
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
  aria-labelledby="theme-title"
>
  <div
    class="pointer-events-auto flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6"
    in:flyIn
    out:fadeOut
  >
    <h2 id="theme-title" class="underline">theme</h2>
    <p class="text-dim">
      every pad in this root takes it, and the read-only links made from now on.
    </p>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
      {#each PRESETS as preset (preset.id)}
        <button
          class="flex cursor-pointer items-center gap-2 border border-ink p-1 text-left {sameTheme(
            preset,
            theme
          )
            ? 'bg-ink text-bg'
            : 'text-ink hover:bg-ink3 hover:text-hi'}"
          onclick={() => pick({ bg: preset.bg, fg: preset.fg, ink: preset.ink })}
        >
          <!-- The preset's three colours. -->
          <span class="flex shrink-0 border border-ink3">
            <span class="size-5" style:background={preset.bg}></span>
            <span class="size-5" style:background={preset.fg}></span>
            <span class="size-5" style:background={preset.ink}></span>
          </span>
          {preset.name}
        </button>
      {/each}
    </div>
    <div class="flex flex-col">
      {#each COLOURS as [key, label] (key)}
        <!-- Shown while it's dragged, saved once it's let go. -->
        <label class="flex items-center justify-between border-b border-ink3 py-1">
          <span>{label}</span>
          <input
            type="color"
            value={theme[key]}
            oninput={(e) => pick({ ...theme, [key]: colour(e) }, false)}
            onchange={(e) => pick({ ...theme, [key]: colour(e) })}
            class="h-8 w-12 cursor-pointer border border-ink bg-bg p-0.5 pointer-coarse:h-10 pointer-coarse:w-16"
          />
        </label>
      {/each}
    </div>
    {#if problem}
      <p class="text-ink" role="alert">► {problem}</p>
    {/if}
    <div class="flex items-center gap-3">
      <button
        class="hit relative h-8 cursor-pointer border border-ink bg-ink px-3 text-bg shadow-raised enabled:hover:bg-hi enabled:active:translate-x-0.5 enabled:active:translate-y-0.5 enabled:active:shadow-sunk pointer-coarse:h-10"
        onclick={onclose}
        {@attach (el) => el.focus()}>done</button
      >
    </div>
  </div>
</div>
