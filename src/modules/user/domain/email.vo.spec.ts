import { Email } from './email.vo';
import { DomainError } from '../../../shared/kernel';

describe('Email', () => {
  it('normalizes trim + lowercase', () => {
    expect(Email.of('  User@Example.COM  ').value).toBe('user@example.com');
  });

  it('accepts a plain valid address', () => {
    expect(Email.of('a@b.co').value).toBe('a@b.co');
  });

  it('rejects malformed addresses', () => {
    expect(() => Email.of('')).toThrow(DomainError);
    expect(() => Email.of('no-at-sign')).toThrow(DomainError);
    expect(() => Email.of('missing@domain')).toThrow(DomainError);
    expect(() => Email.of('spa ce@x.co')).toThrow(DomainError);
  });

  it('compares equal by normalized value', () => {
    expect(Email.of('User@Example.com').equals(Email.of('user@example.com'))).toBe(true);
  });
});
