import { fade, fly } from 'svelte/transition';

// Motion: 120ms in, 90ms out, nothing under reduced motion.
const reduced =
  typeof globalThis.matchMedia === 'function' &&
  globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DURATION = reduced ? 0 : 120;
const EXIT_DURATION = reduced ? 0 : 90;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number) => t * t * t;

export const flyIn = (node: Element) => fly(node, { y: 10, duration: DURATION, easing: easeOut });

export const fadeOut = (node: Element) => fade(node, { duration: EXIT_DURATION, easing: easeIn });
