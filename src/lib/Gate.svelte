<script lang="ts">
  import { goto } from '$app/navigation';
  import * as api from './api.ts';
  import { checkPassword, type Keys } from './crypto.ts';
  import { day, message } from './format.ts';
  import { href } from './href.ts';
  import Button from './ui/Button.svelte';

  let {
    path,
    root,
    mode,
    salt,
    purgeAt = null,
    onunlock
  }: {
    path: string;
    root: string;
    mode: 'claim' | 'unlock' | 'password';
    salt: string | null;
    /** A deleted root's purge: until then, claiming it offers to reclaim it. */
    purgeAt?: number | null;
    onunlock: (keys: Keys) => void;
  } = $props();

  // Reclaiming a deleted root is unlocking it with its old password.
  let reclaiming = $state(false);
  const form = $derived(reclaiming ? 'unlock' : mode);

  // The fields have no names, so even with scripts off the form can't send
  // a password anywhere: it only ever leaves through the code below, as keys.
  let current = $state('');
  let next = $state('');
  let confirm = $state('');
  let busy = $state(false);
  let problem = $state('');

  async function onsubmit(e: SubmitEvent) {
    e.preventDefault();
    if (form !== 'unlock') {
      const bad = checkPassword(next) ?? (next !== confirm ? "the passwords don't match" : null);
      if (bad) return (problem = bad);
    }
    busy = true;
    problem = '';
    try {
      if (form === 'claim') onunlock(await api.claim(root, next));
      else if (form === 'unlock') onunlock(await api.unlock(root, current, salt!));
      else {
        await api.changePassword(root, current, next, salt!);
        await goto(href(path.split('/')), { invalidateAll: true });
      }
    } catch (e) {
      problem = message(e, 'something went wrong');
    } finally {
      busy = false;
    }
  }
</script>

{#snippet field(
  label: string,
  autocomplete: 'current-password' | 'new-password',
  get: () => string,
  set: (v: string) => void
)}
  <label class="flex flex-col gap-1">
    <span class="text-dim">{label}</span>
    <input
      class="h-8 border border-ink bg-bg px-2 text-fg pointer-coarse:h-10"
      type="password"
      {autocomplete}
      required
      maxlength="256"
      bind:value={get, set}
    />
  </label>
{/snippet}

<main class="flex min-h-dvh flex-col items-center justify-center px-3 py-8">
  <form class="flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6" {onsubmit}>
    <!-- For password managers: what the password is for. -->
    <input type="text" autocomplete="username" value="/{root}" hidden readonly />
    {#if form === 'claim'}
      <h1 class="border-b border-ink text-xl break-all">/{root} is free</h1>
      {#if purgeAt !== null}
        <p class="text-ink">
          ► a deleted /{root} is still here until {day(purgeAt)}. its old password reclaims it;
          claiming /{root} anew deletes it for good.
          <Button
            type="button"
            class="underline"
            onclick={() => {
              reclaiming = true;
              problem = '';
            }}>reclaim it</Button
          >
        </p>
      {/if}
      <p class="text-dim">
        set its password. it locks /{root} and every pad under it, for reading too. the pads are encrypted
        with it in your browser: the server never sees it, so if you lose it, the pads are gone.
      </p>
      {@render field(
        'password',
        'new-password',
        () => next,
        (v) => (next = v)
      )}
      {@render field(
        'again',
        'new-password',
        () => confirm,
        (v) => (confirm = v)
      )}
    {:else if form === 'unlock'}
      <h1 class="border-b border-ink text-xl break-all">
        /{root} is {reclaiming ? 'deleted' : 'locked'}
      </h1>
      {#if reclaiming && purgeAt !== null}
        <p class="text-dim">
          its old password brings it back, with every pad and link it had, until {day(purgeAt)}.
        </p>
      {/if}
      {@render field(
        'password',
        'current-password',
        () => current,
        (v) => (current = v)
      )}
    {:else}
      <h1 class="border-b border-ink text-xl break-all">/{root}'s password</h1>
      <p class="text-dim">changing it signs every other browser out of /{root}.</p>
      {@render field(
        'current password',
        'current-password',
        () => current,
        (v) => (current = v)
      )}
      {@render field(
        'new password',
        'new-password',
        () => next,
        (v) => (next = v)
      )}
      {@render field(
        'again',
        'new-password',
        () => confirm,
        (v) => (confirm = v)
      )}
    {/if}
    {#if problem}
      <p class="text-ink" role="alert">► {problem}</p>
    {/if}
    <div class="flex items-center gap-3">
      <Button variant="primary" disabled={busy}>
        {busy
          ? 'deriving keys…'
          : form === 'claim'
            ? 'claim'
            : reclaiming
              ? 'reclaim'
              : form === 'unlock'
                ? 'unlock'
                : 'change'}
      </Button>
      {#if reclaiming}
        <Button
          type="button"
          onclick={() => {
            reclaiming = false;
            problem = '';
          }}>claim anew</Button
        >
      {:else if mode === 'password'}
        <Button href={href(path.split('/'))}>cancel</Button>
      {:else}
        <Button href="/">another pad</Button>
      {/if}
    </div>
  </form>
</main>
