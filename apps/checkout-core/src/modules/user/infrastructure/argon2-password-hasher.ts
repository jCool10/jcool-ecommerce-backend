import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import type { PasswordHasherPort } from '../application/ports';

/**
 * argon2id (memory-hard, OWASP-recommended). The digest embeds salt + params, so raising the
 * configured cost later still verifies previously stored hashes.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasherPort {
  private readonly memoryCost: number;
  private readonly timeCost: number;
  private readonly parallelism: number;

  constructor(config: ConfigService) {
    this.memoryCost = config.getOrThrow<number>('argon2.memoryCost');
    this.timeCost = config.getOrThrow<number>('argon2.timeCost');
    this.parallelism = config.getOrThrow<number>('argon2.parallelism');
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
    } catch {
      return false;
    }
  }
}
