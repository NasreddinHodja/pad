import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Adapter, Builder } from '@sveltejs/kit';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

// The release builds with SOURCE_DATE_EPOCH, the commit's time, so a tag
// builds the same bytes. Otherwise two builds differ in the version
// (Date.now()) and in each file's mtime, which adapter-bun writes into
// build/adapter-bun.js for Last-Modified.
const epoch = process.env.SOURCE_DATE_EPOCH;

function reproducible(adapter: Adapter): Adapter {
  if (!epoch) return adapter;
  const touch = (dir: string, files: string[]) => {
    for (const file of files) utimesSync(join(dir, file), +epoch, +epoch);
  };
  return {
    ...adapter,
    adapt: (builder) =>
      adapter.adapt(
        new Proxy(builder, {
          get(target, key: keyof Builder) {
            if (key !== 'writeClient' && key !== 'writePrerendered') return target[key];
            return (dest: string) => {
              const files = target[key](dest);
              touch(dest, files);
              return files;
            };
          }
        })
      )
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes('node_modules') ? undefined : true
      },

      adapter: reproducible(adapter()),
      ...(epoch && { version: { name: epoch } }),

      // The keys sit in this page, so a script injected into it could use
      // them: only our own scripts run. konigslibrary's policy, less GitHub.
      // - 'wasm-unsafe-eval': Argon2id is hash-wasm's WebAssembly.
      // - style-src 'unsafe-inline': app.html's style attribute.
      // - Trusted Types: a string given to innerHTML and the like throws,
      //   unless it went through Svelte's own policy, which its compiled
      //   templates use; {@html} of a string throws too.
      // Rules for what may change here: CONTRIBUTING.org, XSS.
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          'script-src': ['self', 'wasm-unsafe-eval'],
          'style-src': ['self', 'unsafe-inline'],
          'img-src': ['self', 'data:'],
          'connect-src': ['self'],
          'object-src': ['none'],
          'base-uri': ['none'],
          'form-action': ['self'],
          'frame-ancestors': ['none'],
          'require-trusted-types-for': ['script'],
          'trusted-types': ['svelte-trusted-html']
        }
      }
    })
  ]
});
