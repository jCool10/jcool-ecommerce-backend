import { describe, expect, it } from 'vitest';
import { escapeHtml } from './html-escape';

describe('escapeHtml', () => {
  it('escapes every reserved character', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });

  it('neutralizes an attribute-breakout attempt', () => {
    const attack = '"><script>alert(1)</script>';
    const escaped = escapeHtml(attack);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
