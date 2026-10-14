// The text every client script types into and seed.ts seals: words drawn by a
// 31-bit LCG, a newline after one word in ten. One module, so a floor holds
// the very text of the pad it stands in for.

const words =
  'the of and to in is that it for on as with was his by at from this be or have an are not but had they you were which her one all their there can been'.split(
    ' '
  );

// seed = (seed × 1103515245 + 12345) mod 2^31. Math.imul keeps the product's
// low 32 bits exactly; a float product passes 2^53 and loses them, which
// made the earlier generator fall into a cycle of 10,466 draws.
export function generator(seed = 1) {
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 2 ** 31;
  const text = (n: number) => {
    let s = '';
    while (s.length < n) s += words[Math.floor(rnd() * words.length)] + (rnd() < 0.1 ? '\n' : ' ');
    return s.slice(0, n);
  };
  return { rnd, text };
}

// The roots seed.ts makes. avg is shaped like the author's root (capacity.org:
// median 437 B, p90 2,992, p99 4,232, max 249,586; 186 pads, 423 KB); max is
// the quota, 5,000 pads, its root pad the most a pad holds less 8 KiB, the
// room the scripts type into (2,000 characters at most): sealed, a pad's
// text, a marker byte, padding to the Padmé size (padme.ts) and AES-GCM's 28
// bytes come to 516,124 for 516,095 characters, and one more pads to 524,316,
// over 512 KiB. Its other pads hold 2,943 characters: sealed, 2,972 bytes, and
// with their sealed names the 5,000 fit the root's 16 MiB; 2,944 would pad to
// 3,100, and don't.
export const ROOT_CHARS = { avg: 249_000, max: 516_095 - 8192 } as const;
export type Kind = keyof typeof ROOT_CHARS;
export const ROOT_NAME: Record<Kind, string> = { avg: 'avgroot', max: 'bigroot' };

// Every pad of a root, root first, with its text. The sizes are drawn before
// any text, so the root pad's text is the same whichever order it is saved in.
export function pads(kind: Kind, root = ROOT_NAME[kind]): [string, string][] {
  const g = generator();
  const avgSize = (i: number) => {
    if (i === 0) return ROOT_CHARS.avg;
    const q = g.rnd();
    return Math.round(
      q < 0.5
        ? 50 + q * 2 * 390
        : q < 0.9
          ? 437 + ((q - 0.5) / 0.4) * 2555
          : 2992 + ((q - 0.9) / 0.1) * 1240
    );
  };
  const sized: [string, number][] =
    kind === 'avg'
      ? Array.from({ length: 186 }, (_, i) => [
          i === 0 ? root : `${root}/${['notes', 'work', 'misc'][i % 3]}/p${i}`,
          avgSize(i)
        ])
      : Array.from({ length: 5000 }, (_, i) => [
          i === 0 ? root : `${root}/d${i % 50}/p${i}`,
          i === 0 ? ROOT_CHARS.max : 2943
        ]);
  return sized.map(([path, n]) => [path, g.text(n)]);
}

// The root pad's text alone, for the floors.
export const rootText = (kind: Kind) => pads(kind)[0][1];

// A floor's text: a root's (avg, max) or the first <chars> of the generator.
export const floorText = (arg: string) =>
  arg === 'avg' || arg === 'max' ? rootText(arg) : generator().text(Number(arg));
