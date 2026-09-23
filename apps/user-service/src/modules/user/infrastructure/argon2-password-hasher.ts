import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import type { PasswordHasherPort } from '../application/ports';

const LOG_CONTEXT = 'Argon2PasswordHasher';

/**
 * argon2id (memory-hard, OWASP-recommended). The digest embeds salt + params, so raising the
 * configured cost later still verifies previously stored hashes.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasherPort {
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;

  constructor(
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.memoryCost = config.getOrThrow<number>('argon2.memoryCost');
    this.timeCost = config.getOrThrow<number>('argon2.timeCost');
    this.parallelism = config.getOrThrow<number>('argon2.parallelism');
    logger.setContext(LOG_CONTEXT);
  }

  // No `raw` option → argon2 returns the PHC string rather than bare bytes.
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
      parallelism: this.parallelism,
    });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    // A malformed/foreign hash makes argon2.verify throw; treat that as a
    // non-match rather than leaking a 500 to the auth flow.
    try {
      return await argon2.verify(hash, plain);
    } catch (error) {
      this.logger.error({ err: toError(error) }, 'password hash verify errored — treated as no match');
      return false;
    }
  }
}
