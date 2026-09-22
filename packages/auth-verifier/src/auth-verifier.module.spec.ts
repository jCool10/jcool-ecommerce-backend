import type { Server } from 'node:http';
import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type CryptoKey, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import request from 'supertest';
import { type AuthenticatedUser, CurrentUser, Public, Roles } from '@jcool/platform/rbac';
import { AuthVerifierModule } from './auth-verifier.module';
import { SESSION_EPOCH } from './session-epoch.port';
import { TOKEN_DENYLIST } from './token-denylist.port';

const ISSUER = 'iss';
const AUDIENCE = 'aud';
const KID = 'test-key';
const USER_ID = '137465797020397179';
let privateKey: CryptoKey;

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
  return new SignJWT({ sub: USER_ID, role, jti: 'jti-1', epoch: 0 })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('AuthVerifierModule', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'ES256' };

    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthVerifierModule.forRootAsync({
          imports: [SessionStateModule],
          useFactory: () => ({
            es256: { keys: createLocalJWKSet({ keys: [jwk] }), issuer: ISSUER, audience: AUDIENCE },
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

    expect(res.body).toMatchObject({ userId: USER_ID, role: 'CUSTOMER', jti: 'jti-1' });
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
