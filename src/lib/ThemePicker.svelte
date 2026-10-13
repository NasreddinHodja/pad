<script lang="ts">
  import { message } from './format.ts';
  import { PRESETS, sameTheme, type Theme } from './theme.ts';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';

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
      problem = message(e, "couldn't save the theme");
    });
  }

  const colour = (e: Event) => (e.currentTarget as HTMLInputElement).value;
</script>

<Modal title="theme" {onclose}>
  <p class="text-dim">every pad in this root takes it, and the read-only links made from now on.</p>
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
    <Button variant="primary" onclick={onclose} data-autofocus>done</Button>
  </div>
</Modal>
