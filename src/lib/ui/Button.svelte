<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  // Primary is the one thing a screen is for: filled with ink and raised, and
  // pressed it sinks into its shadow; disabled, it's at work. Text is a bare
  // word, only as tall as its line: `hit` gives it the touch target. With an
  // `href` it's a link that looks the same.
  type Props = {
    variant?: 'primary' | 'text';
    class?: string;
    children: Snippet;
  } & (({ href: string } & HTMLAnchorAttributes) | ({ href?: undefined } & HTMLButtonAttributes));

  let { variant = 'text', class: className = '', children, ...rest }: Props = $props();

  const variantClass = $derived(
    {
      primary:
        'h-8 border border-ink bg-ink px-3 pointer-coarse:h-10 text-bg shadow-raised not-disabled:hover:bg-hi not-disabled:active:translate-x-0.5 not-disabled:active:translate-y-0.5 not-disabled:active:shadow-sunk disabled:cursor-wait',
      text: 'text-ink not-disabled:hover:text-hi not-disabled:hover:underline disabled:cursor-default'
    }[variant]
  );
  const classes = $derived(
    `hit relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 disabled:opacity-40 ${variantClass} ${className}`
  );
</script>

{#if rest.href !== undefined}
  <a class={classes} {...rest as HTMLAnchorAttributes}>{@render children()}</a>
{:else}
  <button class={classes} {...rest as HTMLButtonAttributes}>{@render children()}</button>
{/if}
