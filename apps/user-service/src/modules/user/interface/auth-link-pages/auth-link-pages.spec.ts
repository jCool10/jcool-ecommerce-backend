import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  linkInvalidPage,
  resetPasswordFormPage,
  resetPasswordSuccessPage,
  sendHtmlPage,
  verifyEmailSuccessPage,
} from './auth-link-pages';

function fakeResponse() {
  const headers: Record<string, string> = {};
  const state = { status: 0, body: '', type: '' };
  const res = {
    status: (code: number) => {
      state.status = code;
      return res;
    },
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    type: (contentType: string) => {
      state.type = contentType;
      return res;
    },
    send: (body: string) => {
      state.body = body;
    },
  } as unknown as Response;
  return { res, headers, state };
}

describe('auth link pages', () => {
  it('renders a hidden token field with the raw token escaped', () => {
    const html = resetPasswordFormPage('"><script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('escapes a validation error message shown above the form', () => {
    const html = resetPasswordFormPage('tok-1', '<b>bad</b>');
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
    expect(html).not.toContain('<b>bad</b>');
  });

  it('omits the notice paragraph when there is no error', () => {
    expect(resetPasswordFormPage('tok-1')).not.toContain('role="alert"');
  });

  it('renders static success and invalid pages with no dynamic content to escape', () => {
    expect(verifyEmailSuccessPage()).toContain('verified');
    expect(linkInvalidPage()).toContain('invalid or has expired');
    expect(resetPasswordSuccessPage()).toContain('password has been reset');
  });

  it('sends the security headers and status this module promises for every link page', () => {
    const { res, headers, state } = fakeResponse();
    sendHtmlPage(res, 400, '<p>x</p>');

    expect(state.status).toBe(400);
    expect(state.type).toBe('html');
    expect(state.body).toBe('<p>x</p>');
    expect(headers).toEqual({
      'Content-Security-Policy': "default-src 'none'; form-action 'self'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
    });
  });
});
