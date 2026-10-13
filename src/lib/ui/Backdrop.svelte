<script lang="ts">
  import { fadeOut } from './motion.ts';

  // A 50% checker over the page, under what's open on it; a click on it closes that.
  let { onclick }: { onclick: () => void } = $props();
</script>

<button class="fixed inset-0 z-40 checker" aria-label="close" tabindex="-1" {onclick} out:fadeOut
></button>
