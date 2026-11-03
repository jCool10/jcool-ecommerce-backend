import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader, loginAs } from '../setup/auth.helper';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { RbacProbeController } from '../setup/rbac-probe.controller';
import { publishedEpoch, storedEpoch } from '../setup/session-epoch.helper';
import { workerDatabaseUrl, workerRedisUrl } from '../setup/worker-resources';

const execFileAsync = promisify(execFile);
// Specs compile as CommonJS (no `import.meta`); the runner always starts at the package root.
const packageRoot = process.cwd();
const SCRIPT_TIMEOUT_MS = 60_000;

describe('set-user-role script (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({}, [], { controllers: [RbacProbeController] }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  function runScript(...args: string[]): Promise<{ stdout: string }> {
    return execFileAsync(join(packageRoot, 'node_modules/.bin/tsx'), [join('scripts', 'set-user-role.ts'), ...args], {
      cwd: packageRoot,
      timeout: SCRIPT_TIMEOUT_MS,
      env: { ...process.env, DATABASE_URL: workerDatabaseUrl(), REDIS_URL: workerRedisUrl() },
    });
  }

  it('demotes an admin and refuses the admin token it was holding at once', async () => {
    const { user, password } = await createTestAdmin(app);
    const held = await loginAs(app, { email: user.email, password });
    await request(app.getHttpServer()).post('/admin-probe').set(authHeader(held.accessToken)).expect(204);

    await runScript(user.email.toUpperCase(), 'CUSTOMER');

    await request(app.getHttpServer()).get('/auth/me').set(authHeader(held.accessToken)).expect(401);
    expect(await storedEpoch(pool, user.id)).toBe(1);
    expect(await publishedEpoch(app, user.id)).toBe(1);
    // The session survives: a new login carries the new role.
    const relogin = await loginAs(app, { email: user.email, password });
    await request(app.getHttpServer()).post('/admin-probe').set(authHeader(relogin.accessToken)).expect(403);
  });

  it('fails without touching anything for an unknown user or a role that does not exist', async () => {
    const { user } = await createTestAdmin(app);

    await expect(runScript('nobody@test.local', 'CUSTOMER')).rejects.toMatchObject({ code: 1 });
    await expect(runScript(user.email, 'SUPERUSER')).rejects.toMatchObject({ code: 1 });

    expect(await storedEpoch(pool, user.id)).toBe(0);
    const { rows } = await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [user.id]);
    expect(rows[0].role).toBe('ADMIN');
  });
});
