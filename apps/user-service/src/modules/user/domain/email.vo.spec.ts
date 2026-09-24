import { Email } from './email.vo';
import { DomainError } from '@jcool/kernel';

describe('Email', () => {
  it('normalizes by trimming and lowercasing', () => {
    expect(Email.of('  User@Example.COM  ').value).toBe('user@example.com');
  });

  it('rejects malformed addresses', () => {
    const malformed = ['', 'no-at-sign', 'missing@domain', 'spa ce@x.co'];

    const refused = malformed.filter((raw) => {
      try {
        Email.of(raw);
        return false;
      } catch (error) {
        return error instanceof DomainError;
      }
    });

    expect(refused).toEqual(malformed);
  });
});
