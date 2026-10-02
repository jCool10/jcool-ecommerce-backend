import type { IdGeneratorPort } from '../ports/id-generator.port';

/** The one way rows here get an id. Framework-free, so the seed scripts construct it without booting Nest. */
export class IdGeneratorService {
  constructor(private readonly idGenerator: IdGeneratorPort) {}

  async mintId(): Promise<string> {
    const [id] = await this.idGenerator.mint(1);
    return id;
  }
}
