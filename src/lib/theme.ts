// A root's theme: three colours the rest is mixed from, presets after
// konigslibrary's:
// https://github.com/NasreddinHodja/konigslibrary/blob/main/src/lib/theme/index.ts
// The marble behind the panels is recoloured to match. This browser
// remembers each root's, so app.html can put it on before the first paint;
// the root keeps it sealed (api.ts).

export type Theme = { bg: string; fg: string; ink: string };

export type ThemePreset = Theme & { id: string; name: string };

export const PRESETS: ThemePreset[] = [
  // pad's own, for long reading: off-black and off-white, so the text doesn't
  // glare; text near APCA's Lc 90, links and buttons over WCAG's 7:1.
  { id: 'dusk', name: 'dusk', bg: '#171a2b', fg: '#ece6f3', ink: '#f7b2d6' },
  { id: 'dawn', name: 'dawn', bg: '#f3f2fa', fg: '#1d2140', ink: '#8a2560' },
  { id: 'onebark', name: 'one bark', bg: '#282c34', fg: '#dcdfe4', ink: '#c678dd' },
  { id: 'bubblegum', name: 'bubblegum', bg: '#000000', fg: '#ffe0f0', ink: '#ff8fc8' },
  { id: 'paper', name: 'paper', bg: '#f4f0e8', fg: '#141414', ink: '#141414' },
  { id: 'white', name: 'white', bg: '#000000', fg: '#ffffff', ink: '#ffffff' }
];

/** Dusk: layout.css's and bg.png's, and a root's until it picks another. */
export const DEFAULT: Theme = { bg: PRESETS[0].bg, fg: PRESETS[0].fg, ink: PRESETS[0].ink };

const HEX = /^#[0-9a-f]{6}$/i;

/** A theme as saved, any of its colours that isn't one taken from DEFAULT. */
export function parseTheme(saved: unknown): Theme {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const pick = (v: unknown, fallback: string) =>
    typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback;
  return { bg: pick(s.bg, DEFAULT.bg), fg: pick(s.fg, DEFAULT.fg), ink: pick(s.ink, DEFAULT.ink) };
}

export const sameTheme = (a: Theme, b: Theme) => a.bg === b.bg && a.fg === b.fg && a.ink === b.ink;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const lightness = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** `a` at `amount` over `b`, as CSS's `color-mix(in srgb, …)` makes it. */
function mix(a: string, b: string, amount: number) {
  const [x, y] = [rgb(a), rgb(b)];
  return (
    '#' +
    x
      .map((v, i) =>
        Math.round(v * amount + y[i] * (1 - amount))
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

/** Hover: the ink moved away from the background; an ink already at that end moves back toward it. */
function hover(theme: Theme) {
  const away = mix(theme.ink, lightness(theme.bg) < 0.5 ? '#ffffff' : '#000000', 0.6);
  return Math.abs(lightness(away) - lightness(theme.ink)) < 0.08
    ? mix(theme.ink, theme.bg, 0.75)
    : away;
}

/** What app.html sets before the first paint: the colours layout.css doesn't mix itself. */
const vars = (theme: Theme) => ({
  '--color-bg': theme.bg,
  '--color-fg': theme.fg,
  '--color-ink': theme.ink,
  '--color-hi': hover(theme)
});

let marble: Promise<HTMLImageElement> | undefined;
// The last two drawn: the theme on now and the one a cancelled pick goes back to.
const textures = new Map<string, string>();
let call = 0;
let applied: Theme | undefined;

const textureKey = (theme: Theme) => theme.bg + mix(theme.ink, theme.bg, 0.6);

/** bg.png, two colours, redrawn in the theme's background and ink2; a data: URL, as the CSP takes. */
async function texture(theme: Theme) {
  const key = textureKey(theme);
  const done = textures.get(key);
  if (done) return done;
  marble ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = '/bg.png';
  });
  const img = await marble;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, img.width, img.height);
  const [bg, ink2] = [rgb(theme.bg), rgb(mix(theme.ink, theme.bg, 0.6))];
  const red = rgb(DEFAULT.bg)[0];
  for (let i = 0; i < data.data.length; i += 4) data.data.set(data.data[i] !== red ? ink2 : bg, i);
  g.putImageData(data, 0, 0);
  const url = canvas.toDataURL('image/png');
  textures.set(key, url);
  if (textures.size > 2) textures.delete(textures.keys().next().value!);
  return url;
}

export function applyTheme(theme: Theme) {
  if (applied && sameTheme(applied, theme)) return;
  const was = applied;
  applied = { ...theme };
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(vars(theme))) root.setProperty(name, value);
  const mine = ++call;
  if (sameTheme(theme, DEFAULT)) {
    root.removeProperty('--texture');
    return;
  }
  const done = textures.get(textureKey(theme));
  if (done) {
    root.setProperty('--texture', `url(${done})`);
    return;
  }
  // The default marble's colours under another theme's would flash: none until
  // it's drawn. Another theme's marble stays meanwhile, a drag's last colour.
  if (!was || sameTheme(was, DEFAULT)) root.setProperty('--texture', 'none');
  texture(theme)
    .catch(() => null)
    .then((url) => {
      if (mine === call && url) root.setProperty('--texture', `url(${url})`);
    });
}

const KEY = 'pad-theme:';

/** What this browser last saw of the root's theme. */
export function rememberedTheme(root: string) {
  try {
    const raw = localStorage.getItem(KEY + root);
    return raw ? parseTheme(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function rememberTheme(root: string, theme: Theme | null) {
  try {
    if (!theme || sameTheme(theme, DEFAULT)) localStorage.removeItem(KEY + root);
    else localStorage.setItem(KEY + root, JSON.stringify({ ...theme, vars: vars(theme) }));
  } catch {
    // Not remembered, then: the root's own copy still has it.
  }
}
