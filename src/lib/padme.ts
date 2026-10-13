// What a sealed thing's size shows: Padmé (Nikitin et al., "Reducing
// Metadata Leakage from Encrypted Files and Communication with PURBs",
// Algorithm 1) rounds a length up so its binary float has no more mantissa
// bits than exponent bits: at most 12% more, and lengths fall into few sizes.
// Measured on pads: docs/architecture/encryption.org, Padding.

/** The length `length` bytes are padded to, `floor` at least. */
export function padded(length: number, floor = 0) {
  const n = Math.max(length, floor);
  if (n < 2) return n;
  const e = Math.floor(Math.log2(n));
  const zeros = e - (Math.floor(Math.log2(e)) + 1);
  const step = 2 ** zeros;
  return Math.ceil(n / step) * step;
}
