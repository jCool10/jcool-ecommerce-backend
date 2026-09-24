import { requestWithoutQuery } from './request-serializer';

describe('requestWithoutQuery', () => {
  // Mailed verification and reset links carry a redeemable token in the query string.
  it('drops the query string and the parsed query', () => {
    const logged = requestWithoutQuery({
      id: 1,
      method: 'GET',
      url: '/auth/verify-email?token=secret-token',
      query: { token: 'secret-token' },
      headers: { host: 'shop.test' },
    });

    expect(logged).toEqual({ id: 1, method: 'GET', url: '/auth/verify-email', headers: { host: 'shop.test' } });
  });
});
