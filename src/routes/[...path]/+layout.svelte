<script lang="ts">
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import { pathOf } from '#lib/href.ts';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();

  // The server knows only the root: the rest of the path is after the `#`.
  const path = $derived((browser && pathOf(page.url)) || page.data.root);
</script>

<!-- Here, not in the gate or the editor: the server renders neither, since
     which one shows waits on the keys in IndexedDB. A root's name is all a
     search engine or a link preview could learn of a pad: the text is locked,
     and the path under the root never leaves the browser. -->
<svelte:head>
  <title>{path} · pad</title>
  <meta property="og:title" content="/{page.data.root}" />
</svelte:head>

{@render children()}
