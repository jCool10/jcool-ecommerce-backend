import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Read off disk, not `import pkg from '../package.json'`: the SWC builder has `sourceRoot: "src"`,
 * so importing a file above it pulls package.json into the compilation and shifts the output to
 * `dist/src/main.js`, breaking `start:prod`. Typecheck stays green, so it only surfaces at deploy.
 */
function readApiVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    // Docs are not worth refusing to boot over; npm exports the same value when it started us.
    return process.env.npm_package_version ?? '0.0.0';
  }
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('JCool E-commerce API')
    .setDescription(
      [
        'Single-store e-commerce backend — six bounded contexts in one deployable process.',
        '',
        '- **User** — register/login, email verification, password reset, JWT + refresh rotation, sessions, RBAC.',
        '- **Catalog** — public product/SKU reads and search; admin CRUD behind `ADMIN`.',
        '- **Cart** — per-user cart lines, priced from the catalog at read time.',
        '- **Order** — checkout: the order, not the cart, is the source of truth for a transaction.',
        '- **Payment** — gateway sessions and the webhook sink; one purchase intent, one charge.',
        '- **Inventory** — stock reservations that hold the "never oversell" invariant under contention.',
      ].join('\n'),
    )
    .setVersion(readApiVersion())
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}
