import { describe, expect, it } from 'vitest';
import { stripControlCharacters } from './strip-control-characters';

describe('stripControlCharacters', () => {
  it('drops ESC, CR, NUL, DEL and C1 controls', () => {
    expect(stripControlCharacters('a\u001b[2Jb\rc\u0000d\u007fe\u009bf\u0085g')).toBe('a[2Jbcdefg');
  });

  it('keeps Vietnamese text and its diacritics', () => {
    const text = 'Đơn hàng đã được thanh toán — Nguyễn Thị Ánh';

    expect(stripControlCharacters(text)).toBe(text);
  });
});
