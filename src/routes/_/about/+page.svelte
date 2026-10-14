<script lang="ts">
  import Button from '#lib/ui/Button.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  const REPO = 'https://github.com/NasreddinHodja/pad.nassu.online';
  const doc = (file: string, heading = '') => `${REPO}/blob/main/docs/${file}${heading}`;

  /** Whole KiB, MiB or GiB, as the limits are set. */
  function size(bytes: number) {
    const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) [bytes, i] = [bytes / 1024, i + 1];
    return `${Math.round(bytes * 10) / 10} ${units[i]}`;
  }
  const days = (ms: number) => `${Math.round(ms / 86_400_000)} days`;
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

  const keys = [
    ['ctrl+/', 'opens it from anywhere; inside it, closes it'],
    ['↑ / ctrl+k / ctrl+p', 'the next match up'],
    ['↓ / ctrl+j / ctrl+n', 'the next match down'],
    ['↵', 'opens the match, or makes the typed path if none'],
    ['ctrl+↵', 'makes the typed path, even when something matches'],
    ['esc', 'closes it']
  ];
</script>

<svelte:head>
  <title>about · pad</title>
  <meta name="description" content="how pad works, what its server sees, and its source" />
  <meta property="og:title" content="about pad" />
</svelte:head>

{#snippet a(href: string, text: string)}
  <a {href} class="text-ink underline hover:text-hi">{text}</a>
{/snippet}

<main class="flex min-h-dvh flex-col items-center px-3 py-8">
  <article class="flex w-full max-w-2xl flex-col gap-6 panel p-3 leading-relaxed sm:p-8">
    <Button class="self-start" href="/">← pad</Button>

    <section class="flex flex-col gap-3">
      <h1 class="border-b border-ink text-xl">pad</h1>
      <p>
        a notepad at every url. open /anything, type, and it saves. every pad is encrypted in your
        browser with a key from its root's password.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h2 class="border-b border-ink text-xl">how to use it</h2>

      <h3 class="underline">paths</h3>
      <p>
        any path is a pad: /notes, /notes/today, /notes/today/later. a pad is made by typing in it
        and deleted by emptying it: it leaves its parent's list and its text leaves the server. a
        path has up to {data.path.depth} segments of up to {data.path.segment} characters,
        {data.path.chars} in all. case doesn't count: /Notes is /notes. /_/… is the server's own.
      </p>

      <h3 class="underline">roots and passwords</h3>
      <p>
        the first segment is the root: /notes/today belongs to notes. in the address bar, what's
        under the root comes after a #: /notes#today/later. browsers never send that part, so the
        server knows which root you're in but not which pad.
      </p>
      <ul class="flex list-inside list-disc flex-col gap-2">
        <li>
          a root nobody has saved under is free. opening it asks for a password, which then guards
          the root and every pad under it, for reading as well as writing.
        </li>
        <li>
          a locked root asks for its password. {data.backoff.free} wrong ones are free; after that each
          try waits twice as long as the last, up to {minutes(data.backoff.maxWait)}. a browser that
          has unlocked the root before only waits for its own wrong passwords; any other, for its
          address's. no one else's wrong passwords make you wait.
        </li>
        <li>
          <span class="text-ink">password</span>, in a pad's header, changes the root's password and
          signs every other browser out.
        </li>
        <li><span class="text-ink">lock</span> signs this browser out and forgets its keys.</li>
        <li>
          <span class="text-ink">delete</span>, in a root's header, deletes the root and every pad
          under it, stops its links and signs every browser out. for {days(data.grace)} its old password
          brings all of it back; claiming the root anew instead, or the days passing, deletes it for good.
        </li>
      </ul>
      <p>
        an unlock lasts {days(data.idle)} unused, {days(data.absolute)} at most. a lost password can't
        be recovered: the pads are encrypted with it.
      </p>
      <p>
        {#if data.retention}
          a root no browser has unlocked or had open for {days(data.retention)} is deleted here, as if
          by its delete; its password brings it back for {days(data.grace)} after.
        {:else}
          a root is kept here until it's deleted.
        {/if}
      </p>

      <h3 class="underline">saving</h3>
      <p>
        a pad saves 600ms after you stop typing, when it loses focus and when the tab is hidden; its
        header says unsaved, saving… or saved. if two browsers save over the same version, the pad
        keeps both texts, what differs between &lt;&lt;&lt;&lt;&lt;&lt;&lt; and
        &gt;&gt;&gt;&gt;&gt;&gt;&gt; lines. a pad with nothing unsaved picks up others' saves every
        5 seconds, every 30 while its window is in the background.
      </p>
      <p>
        here a pad holds {size(data.padBytes)}, and a root {size(data.rootBytes)}, its links
        included, and {data.rootPads} pads, emptied ones counted for {days(data.grace)}. each
        address adds at most {size(data.growthPerDay)} a day.
      </p>

      <h3 class="underline">history</h3>
      <p>
        {#if data.versions}
          a pad keeps its last {data.versions} earlier texts: one every
          {minutes(data.versionGap)} of typing, and the last before each pause. emptying a pad keeps its
          text among them, for {days(data.grace)}.
          <span class="text-ink">history</span>, in a pad's header, lists them;
          <span class="text-ink">restore</span> saves one as the newest, keeping what was there
          among them. they count toward the root's {size(data.rootBytes)}; a full root drops its
          oldest first, so a save is never refused for them.
        {:else}
          this server keeps no earlier texts of a pad.
        {/if}
      </p>

      <h3 class="underline">read-only links</h3>
      <p>
        <span class="text-ink">share</span>, in a pad's header, lists its links;
        <span class="text-ink">new link</span> makes one: a copy of the pad and every pad under it
        as they are then, which anyone with the link can read but not change. later edits don't
        reach it; make a new link to share them. its page shows the pad and the pads under it, and
        <span class="text-ink">edit</span> goes to the real pad, for those with the password. a new
        link lasts a week unless you pick otherwise, from an hour to a year or until revoked. it can
        open once: its page asks for a click, then the server deletes the copy as it sends it. it
        can have a password, which the reader is asked for; the server never sees it, nor which
        links have one, but it knows how long a link lasts and whether it opens once.
        <span class="text-ink">revoke</span> deletes the copy and the link stops working;
        <span class="text-ink">revoke all</span>, pressed twice, does it for every link to the pad.
        emptying a pad leaves its links. a link holds {size(data.linkBytes)} once compressed, and a root
        {data.linksPerRoot} links, counted in its {size(data.rootBytes)}.
      </p>

      <h3 class="underline">themes and export</h3>
      <p>
        <span class="text-ink">theme</span>, in a root pad's header, picks the root's colours: pad's
        own, made for long reading (dusk, the default, and dawn), one of
        {@render a('https://github.com/NasreddinHodja/konigslibrary', 'konigslibrary')}'s, or a
        background, text and ink of its own. every pad under the root takes it, and so do links made
        after. it's sealed like the pads, so the password page shows it only in a browser that has
        unlocked the root.
      </p>
      <p>
        <span class="text-ink">export</span> saves the pad and every pad under it as a zip of org files,
        made in the browser: /notes gives notes.org, notes/today.org, notes/today/later.org. pads that
        only have pads under them are just folders.
      </p>

      <h3 class="underline">finder</h3>
      <p>
        the field under a pad finds and makes pads under it. matching is fzf-like: the typed
        characters in order, word starts and runs first.
      </p>
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {#each keys as [key, does] (key)}
          <dt class="text-ink">{key}</dt>
          <dd>{does}</dd>
        {/each}
      </dl>
    </section>

    <section class="flex flex-col gap-3">
      <h2 class="border-b border-ink text-xl">what the server sees</h2>
      <p>
        the browser encrypts every pad's text and path before sending them, with keys from the
        root's password, which never leaves it. the server keeps each root's name, and for it a
        salt, a hash to check the password against, and sealed bytes it has no key for. it sees
        which root is open, not which pad, and how many pads a root has with their sizes, rounded up
        so that many share one.
      </p>
      <p>
        pad loads nothing from other sites, runs no analytics, writes no log of requests, and has no
        accounts: a root's password is its only key. the proxy in front of a server sees every
        request, and whoever runs it decides whether it keeps them.
      </p>
      <p>
        how, and what that doesn't protect against: {@render a(
          doc('architecture/encryption.org'),
          'encryption and access'
        )}, {@render a(doc('guide/install.org', '#what-the-proxy-sees'), 'what the proxy sees')}.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h2 class="border-b border-ink text-xl">source</h2>
      <p>
        pad is free software, under the MIT licence: {@render a(REPO, 'github')}. this server says
        it runs {@render a(`${REPO}/releases/tag/v${data.version}`, `v${data.version}`)}; each
        release lists the hashes of the files a page loads, and
        {@render a(doc('guide/install.org', '#verifying-a-release'), 'a script')} checks a server serves
        them. to run your own:
        {@render a(doc('guide/install.org'), 'installing pad')}.
      </p>
    </section>

    <section class="flex flex-col gap-3">
      <h2 class="border-b border-ink text-xl">credits</h2>
      <p>
        the font is WebPlus IBM VGA 9x16 from VileR's
        {@render a('https://int10h.org/oldschool-pc-fonts/', 'Ultimate Oldschool PC Font Pack')},
        under
        {@render a('https://creativecommons.org/licenses/by-sa/4.0/', 'CC BY-SA 4.0')}.
      </p>
      <p>
        the marble behind the panels is marble.xbm from Anthony Thyssen's
        {@render a('https://github.com/codingisacopingstrategy/AIcons', 'AIcons')} library, which he released
        as almost all public domain, with no restriction listed for it.
      </p>
    </section>
  </article>
</main>
