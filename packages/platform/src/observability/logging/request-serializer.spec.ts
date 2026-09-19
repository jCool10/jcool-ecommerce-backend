import { requestWithoutQuery } from './request-serializer';

describe('requestWithoutQuery', () => {
  it('drops the query string, which carries the tokens in mailed links', () => {
    const logged = requestWithoutQuery({
      id: 1,
      method: 'GET',
      url: '/auth/verify-email?token=secret-token',
      query: { token: 'secret-token' },
      headers: { host: 'shop.test' },
    });

    expect(logged).toEqual({ id: 1, method: 'GET', url: '/auth/verify-email', headers: { host: 'shop.test' } });
    expect(JSON.stringify(logged)).not.toContain('secret-token');
  });

  it('keeps a url without a query as it is', () => {
    expect(requestWithoutQuery({ method: 'GET', url: '/products/1' })).toEqual({ method: 'GET', url: '/products/1' });
  });
});
