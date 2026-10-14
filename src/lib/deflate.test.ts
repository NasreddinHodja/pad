import { describe, expect, test } from 'bun:test';
import { deflate, inflate } from './deflate.ts';

describe('inflate', () => {
  test('gives back what was deflated, up to its cap', async () => {
    const plain = new Uint8Array(1000).fill(7);
    expect(await inflate(await deflate(plain), 1000)).toEqual(plain);
  });

  test('stops past its cap: a small copy that inflates to a lot is refused', async () => {
    // 64 MiB of zeros deflate to about 64 KiB (1029:1).
    const bomb = await deflate(new Uint8Array(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(128 * 1024);
    await expect(inflate(bomb, 1024 * 1024)).rejects.toThrow('malformed');
  });
});
