import { afterEach, describe, expect, it } from 'vitest';
import { connectPglite, MIGRATIONS_FOLDER } from '../src/index.js';

describe('migrations folder override', () => {
  afterEach(() => {
    delete process.env.VULNSTACK_MIGRATIONS_DIR;
  });

  it('uses the option and the env var', async () => {
    const a = await connectPglite(undefined, { migrationsFolder: MIGRATIONS_FOLDER });
    await a.migrate();
    await a.close();

    process.env.VULNSTACK_MIGRATIONS_DIR = '/nonexistent-dir';
    const b = await connectPglite();
    await expect(b.migrate()).rejects.toThrow();
    await b.close();

    const c = await connectPglite(undefined, { migrationsFolder: MIGRATIONS_FOLDER });
    await c.migrate(); // option wins over env
    await c.close();
  });
});
