<script lang="ts">
  import { goto } from '$app/navigation';
  import { href } from '#lib/href.ts';
  import Button from '#lib/ui/Button.svelte';

  let name = $state('');

  function open(e: SubmitEvent) {
    e.preventDefault();
    const parts = name.split('/').filter(Boolean);
    if (parts.length) goto(href(parts));
  }
</script>

<svelte:head>
  <title>pad.nassu.online</title>
  <meta name="description" content="a notepad at every url" />
  <meta property="og:title" content="pad" />
</svelte:head>

<main class="flex min-h-dvh flex-col items-center justify-center px-3 py-8">
  <div class="flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6">
    <div class="flex flex-col gap-3">
      <h1 class="border-b border-ink text-xl">pad</h1>
      <p class="text-dim">
        any path is a pad: type, and it saves. whoever starts /name sets its password, which then
        guards /name and everything under it.
      </p>
    </div>
    <form class="flex gap-3" onsubmit={open}>
      <label
        class="flex flex-1 items-center border border-ink has-[input:focus-visible]:outline has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-hi has-[input:focus-visible]:outline-dotted"
      >
        <span class="pl-2 text-dim">/</span>
        <input
          class="h-8 min-w-0 flex-1 bg-bg px-1 text-fg outline-none placeholder:text-dim pointer-coarse:h-10"
          bind:value={name}
          {@attach (el) => el.focus()}
          placeholder="my/notes"
          aria-label="pad path"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <Button variant="primary">open</Button>
    </form>
  </div>
</main>
