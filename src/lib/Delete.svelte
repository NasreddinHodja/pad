<script lang="ts">
  import { message } from './format.ts';
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';

  // Deleting a root: it and every pad in it, reclaimable with the password
  // for 30 days.
  let {
    root,
    remove,
    onclose
  }: {
    root: string;
    /** Saves, deletes and leaves the pad. */
    remove: () => Promise<void>;
    onclose: () => void;
  } = $props();

  let busy = $state(false);
  let problem = $state('');

  async function confirm() {
    busy = true;
    problem = '';
    try {
      await remove();
    } catch (e) {
      problem = message(e, "couldn't delete it");
      busy = false;
    }
  }
</script>

<Modal
  title="delete /{root}?"
  role="alertdialog"
  describedby="delete-what"
  onclose={() => !busy && onclose()}
>
  <p id="delete-what" class="text-dim">
    /{root} and every pad under it go, its read-only links stop working, and every browser is signed out.
    for 30 days its password reclaims all of it from /{root}; after that, or once someone claims /{root}
    anew, it's gone for good.
  </p>
  {#if problem}
    <p class="text-ink" role="alert">► {problem}</p>
  {/if}
  <div class="flex items-center gap-3">
    <Button variant="primary" disabled={busy} onclick={confirm}>
      {busy ? 'deleting…' : 'delete'}
    </Button>
    <Button disabled={busy} onclick={onclose} data-autofocus>cancel</Button>
  </div>
</Modal>
