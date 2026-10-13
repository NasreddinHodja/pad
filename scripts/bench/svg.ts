// The docs' graphs as SVG: horizontal bars, light and dark following the
// reader's system. Used by scripts/bench/graphs.ts and client/graphs.ts.

// Emphasis: the point in the accent, the rest in a gray that clears 3:1 on
// the surface; a second series in the categorical palette's orange. Each
// bar's value is written beside it.
const STYLE = `<style>
  svg { --surface: #fcfcfb; --text: #0b0b0b; --muted: #52514e; --rule: #d8d7d2;
        --accent: #2a78d6; --context: #8a8983; --second: #eb6834; }
  @media (prefers-color-scheme: dark) {
    svg { --surface: #1a1a19; --text: #f0efec; --muted: #c3c2b7; --rule: #3a3a37;
          --accent: #3987e5; --context: #6b6a65; --second: #d95926; }
  }
  text { font: 13px system-ui, sans-serif; fill: var(--text); }
  .muted { fill: var(--muted); }
  .title { font-size: 15px; font-weight: 600; }
  .accent { fill: var(--accent); }
  .context { fill: var(--context); }
  .second { fill: var(--second); }
</style>`;

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export type Bar = {
  label: string;
  value: number;
  kind: 'accent' | 'context' | 'second';
  /** What's written beside the bar, if not the value and the unit. */
  text?: string;
};

/**
 * Horizontal bars, one row each, from 0. `reference` draws a dashed rule at a
 * value, labelled. Returns the rows' SVG and their height.
 */
export function bars(
  rows: Bar[],
  {
    x,
    y,
    width,
    max,
    unit,
    reference
  }: {
    x: number;
    y: number;
    width: number;
    max: number;
    unit: string;
    reference?: { value: number; label: string };
  }
) {
  const ROW = 26;
  const BAR = 16;
  const scale = (v: number) => (v / max) * width;
  let svg = '';
  rows.forEach((r, i) => {
    const top = y + i * ROW;
    const w = Math.max(scale(r.value), 2);
    // 4px rounded at the data end, square at the baseline.
    svg += `<path class="${r.kind}" d="M${x} ${top}h${w - 4}a4 4 0 0 1 4 4v${BAR - 8}a4 4 0 0 1 -4 4h${-(w - 4)}z"/>`;
    svg += `<text x="${x - 8}" y="${top + 12}" text-anchor="end">${esc(r.label)}</text>`;
    svg += `<text x="${x + w + 6}" y="${top + 12}" class="muted">${r.text ?? r.value + unit}</text>`;
  });
  const height = rows.length * ROW;
  svg += `<line x1="${x}" x2="${x}" y1="${y - 4}" y2="${y + height - 6}" stroke="var(--muted)"/>`;
  if (reference) {
    const rx = x + scale(reference.value);
    svg += `<line x1="${rx}" x2="${rx}" y1="${y - 8}" y2="${y + height - 6}" stroke="var(--text)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    svg += `<text x="${rx + 4}" y="${y - 10}" class="muted">${esc(reference.label)}</text>`;
  }
  return { svg, height };
}

export function page(width: number, height: number, title: string, note: string, body: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
${STYLE}
<rect width="100%" height="100%" fill="var(--surface)"/>
<text x="16" y="26" class="title">${esc(title)}</text>
<text x="16" y="46" class="muted">${esc(note)}</text>
${body}
</svg>
`;
}
