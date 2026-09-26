import type { Response } from 'express';
import { escapeHtml } from './html-escape';

const RESET_FORM_ACTION = '/auth/reset-password/form';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

export function verifyEmailSuccessPage(): string {
  return page('Email verified', '<p>Your email address is verified. You can close this page and sign in.</p>');
}

/** Shared by both flows: neither reveals more than the JSON POST does for an invalid or expired token. */
export function linkInvalidPage(): string {
  return page(
    'Link invalid or expired',
    '<p>This link is invalid or has expired. Request a new one and try again.</p>',
  );
}

export function resetPasswordFormPage(token: string, error?: string): string {
  const notice = error ? `<p role="alert">${escapeHtml(error)}</p>` : '';
  return page(
    'Reset your password',
    `${notice}<form method="post" action="${RESET_FORM_ACTION}">` +
      `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
      '<label for="password">New password</label>' +
      '<input type="password" id="password" name="password" minlength="8" maxlength="72" required>' +
      '<label for="confirmPassword">Confirm new password</label>' +
      '<input type="password" id="confirmPassword" name="confirmPassword" minlength="8" maxlength="72" required>' +
      '<button type="submit">Reset password</button>' +
      '</form>',
  );
}

export function resetPasswordSuccessPage(): string {
  return page(
    'Password reset',
    '<p>Your password has been reset. Every session was signed out — sign in again with your new password.</p>',
  );
}

// Fixed and short, so a raw string is clearer here than building it through helmet's directive object.
const LINK_PAGE_CSP = "default-src 'none'; form-action 'self'";

/** The token lives in the URL/a hidden field, so these headers apply to every page in this module. */
export function sendHtmlPage(res: Response, status: number, html: string): void {
  res.status(status);
  res.setHeader('Content-Security-Policy', LINK_PAGE_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('html').send(html);
}
