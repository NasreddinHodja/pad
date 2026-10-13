<script lang="ts">
  import Button from '#lib/ui/Button.svelte';
  import { browser } from '$app/env';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import * as api from '#lib/api.ts';
  import { storedKeys, storeKeys, type Keys } from '#lib/crypto.ts';
  import Gate from '#lib/Gate.svelte';
  import { pathOf } from '#lib/href.ts';
  import Pad from '#lib/Pad.svelte';
  import { applyTheme, DEFAULT, rememberedTheme, rememberTheme, type Theme } from '#lib/theme.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  // The pad: the root from the server, the rest from after the `#`, which only
  // the browser has (href.ts). Moving between pads of one root changes only
  // the `#`: nothing is asked of the server.
  const path = $derived(browser ? pathOf(page.url) : data.root);
  const root = $derived(data.root);
  const access = $derived(data.state);

  // The root's keys in this browser: undefined while looking, null if it has none.
  let keys = $state<Keys | null | undefined>(undefined);

  $effect(() => {
    const [r, s] = [root, access];
    keys = undefined;
    if (s !== 'unlocked') {
      keys = null;
      return;
    }
    let current = true;
    storedKeys(r).then((k) => current && (keys = k ?? null));
    return () => (current = false);
  });

  // The root's theme on every page of it, the gate's too: as this browser
  // last saw it, until the root's own copy says.
  let theme = $state<Theme>(DEFAULT);

  $effect(() => {
    const [r, s] = [root, access];
    theme = rememberedTheme(r) ?? DEFAULT;
    if (!keys || s !== 'unlocked') return;
    let current = true;
    api.theme(r, keys).then(
      (t) => {
        if (!current) return;
        theme = t ?? DEFAULT;
        rememberTheme(r, t);
      },
      () => {}
    );
    return () => (current = false);
  });

  $effect(() => {
    applyTheme(theme);
  });
  // Back to pad's own when the page goes, not between one theme and the next.
  $effect(() => () => applyTheme(DEFAULT));

  /** Shows `next`; `keep` saves it to the root too. */
  async function retheme(next: Theme, keep: boolean) {
    theme = next;
    if (!keep || !keys) return;
    rememberTheme(data.root, next);
    await api.setTheme(data.root, keys, next);
  }

  async function onunlock(unlocked: Keys) {
    await storeKeys(data.root, unlocked);
    await invalidateAll();
    keys = unlocked;
  }
</script>

<!-- The server lets this browser in, but it needs the keys too, and the other
     way round: either missing, the password gives both. -->
{#if browser && path === null}
  <main class="flex min-h-dvh flex-col items-center justify-center px-3 py-8">
    <div class="flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6">
      <h1 class="border-b border-ink text-xl">400</h1>
      <p class="text-ink" role="alert">► not a valid pad path</p>
      <Button class="self-start" href="/">another pad</Button>
    </div>
  </main>
{:else if keys === undefined || path === null}
  <!-- Opening the key store takes a moment; nothing to show before. -->
{:else if !keys || data.state !== 'unlocked'}
  <Gate
    {path}
    root={data.root}
    mode={data.state === 'open' || data.state === 'deleted' ? 'claim' : 'unlock'}
    kdf={data.kdf}
    purgeAt={data.purgeAt}
    {onunlock}
  />
{:else if page.url.searchParams.has('password')}
  <Gate {path} root={data.root} mode="password" kdf={data.kdf} {onunlock} />
{:else}
  <!-- A fresh editor per pad, so nothing typed in one leaks into the next. -->
  {#key path}
    <Pad {path} root={data.root} {keys} {theme} {retheme} />
  {/key}
{/if}
