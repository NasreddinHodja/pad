// What a signed-in browser is called in the list of a root's browsers: its
// kind and its system, from the User-Agent, nothing finer. Sealed before it
// leaves the browser (crypto.ts, sealLabel).

const BROWSERS: [RegExp, string][] = [
  [/Firefox\//, 'Firefox'],
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Chrome\//, 'Chromium'],
  [/Safari\//, 'Safari']
];
const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux|BSD/, 'Linux']
];

const first = (list: [RegExp, string][], ua: string) => list.find(([re]) => re.test(ua))?.[1];

export function browserLabel(ua: string) {
  const browser = first(BROWSERS, ua) ?? 'a browser';
  const system = first(SYSTEMS, ua);
  return system ? `${browser} on ${system}` : browser;
}
