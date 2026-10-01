import type { IdGeneratorPort } from '../ports/id-generator.port';

/** The one way rows here get an id. Framework-free, so the seed scripts construct it without booting Nest. */
export class IdentityService {
  constructor(private readonly ids: IdGeneratorPort) {}

  async mintId(): Promise<string> {
    const [id] = await this.ids.mint(1);
    return id;
  }
}
