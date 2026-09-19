import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, createLocalJWKSet } from 'jose';
import request from 'supertest';
import { type AuthenticatedUser, CurrentUser, Public, Roles } from '@jcool/platform/rbac';
import { AuthVerifierModule } from './auth-verifier.module';
import { SESSION_EPOCH } from './session-epoch.port';
import { TOKEN_DENYLIST } from './token-denylist.port';

const SECRET = randomBytes(32).toString('hex');

@Controller()
class ProbeController {
  @Public()
  @Get('open')
  open(): { ok: boolean } {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Roles('ADMIN')
  @Get('admin')
  admin(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  providers: [
    { provide: SESSION_EPOCH, useValue: { current: () => Promise.resolve(0), bump: () => Promise.resolve(1) } },
    { provide: TOKEN_DENYLIST, useValue: { isDenylisted: () => Promise.resolve(false), denylist: () => undefined } },
  ],
  exports: [SESSION_EPOCH, TOKEN_DENYLIST],
})
class SessionStateModule {}

function token(role: string): Promise<string> {
  return new SignJWT({ sub: 'u-1', role, jti: 'jti-1', epoch: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}

describe('AuthVerifierModule', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthVerifierModule.forRootAsync({
          imports: [SessionStateModule],
          useFactory: () => ({
            hs256: { enabled: true, secret: SECRET },
            es256: { keys: createLocalJWKSet({ keys: [] }), issuer: 'iss', audience: 'aud' },
          }),
        }),
      ],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(() => app.close());

  it('lets a public route through without a token', async () => {
    await request(server).get('/open').expect(200);
  });

  it('refuses a protected route without a token', async () => {
    await request(server).get('/me').expect(401);
  });

  it('hands the verified user to the handler, whatever the scheme case', async () => {
    const res = await request(server)
      .get('/me')
      .set('Authorization', `bearer ${await token('CUSTOMER')}`)
      .expect(200);

    expect(res.body).toMatchObject({ userId: 'u-1', role: 'CUSTOMER', jti: 'jti-1' });
  });

  it('authenticates before it authorizes', async () => {
    await request(server).get('/admin').expect(401);
    await request(server)
      .get('/admin')
      .set('Authorization', `Bearer ${await token('CUSTOMER')}`)
      .expect(403);
    await request(server)
      .get('/admin')
      .set('Authorization', `Bearer ${await token('ADMIN')}`)
      .expect(200);
  });
});
