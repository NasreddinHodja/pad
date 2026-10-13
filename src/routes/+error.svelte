<script lang="ts">
  import Button from '#lib/ui/Button.svelte';
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>{page.status} · pad</title>
</svelte:head>

<main class="flex min-h-dvh flex-col items-center justify-center px-3 py-8">
  <div class="flex w-full max-w-xl flex-col gap-3 panel p-3 sm:p-6">
    <h1 class="border-b border-ink text-xl">{page.status}</h1>
    <p class="text-ink" role="alert">► {page.error?.message ?? 'something went wrong'}</p>
    <Button class="self-start" href="/">another pad</Button>
  </div>
</main>
