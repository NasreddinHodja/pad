<script lang="ts">
  import { page } from '$app/state';
  import './layout.css';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();
</script>

<svelte:head>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <!-- The link preview, the same for every pad: a locked pad's text is no one's to show. -->
  <meta property="og:site_name" content={page.url.host} />
  <meta property="og:type" content="website" />
  <meta property="og:url" content={page.url.origin + page.url.pathname} />
  <meta property="og:description" content="a notepad at every url" />
  <meta property="og:image" content="{page.url.origin}/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="PAD in a double-lined box" />
  <meta name="twitter:card" content="summary_large_image" />
</svelte:head>

{@render children()}
