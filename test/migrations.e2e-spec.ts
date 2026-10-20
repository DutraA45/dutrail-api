import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';

/**
 * Migrations que transformam dados existentes, aplicadas sobre linhas criadas
 * no formato anterior a elas.
 *
 * Roda num schema próprio e descartável do banco de teste: as migrations não
 * qualificam o schema, então o `search_path` as leva para lá sem tocar nas
 * tabelas do `public` (que os outros e2e usam). Precisa só de CREATE no banco,
 * não de CREATEDB.
 */

const MIGRATIONS_DIR = 'prisma/migrations';
const FAMILIES_MIGRATION = /_refresh_token_families$/;

function migrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const sqlOf = (name: string) =>
  readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

describe('Migration de famílias de refresh token sobre dados existentes (e2e)', () => {
  const schema = `migration_check_${randomBytes(4).toString('hex')}`;
  let db: Client;

  beforeAll(async () => {
    // Como no global-setup: um DATABASE_URL injetado vence o do arquivo.
    const url =
      process.env.DATABASE_URL ?? parse(readFileSync('.env.test')).DATABASE_URL;
    expect(url).toContain('test');
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.end();
  });

  it('cada token existente vira a sua própria família e a coluna fica NOT NULL', async () => {
    const all = migrations();
    const target = all.findIndex((name) => FAMILIES_MIGRATION.test(name));
    expect(target).toBeGreaterThan(0);

    for (const name of all.slice(0, target)) await db.query(sqlOf(name));

    // Linhas no formato anterior: ativa, revogada (rotação ou reuso antigos)
    // e expirada, de dois usuários.
    await db.query(`
      INSERT INTO "User" (id, email, "updatedAt") VALUES
        ('u1', 'u1@example.test', now()),
        ('u2', 'u2@example.test', now());
      INSERT INTO "RefreshToken" (id, "tokenHash", "userId", "expiresAt", "revokedAt") VALUES
        ('t1', 'h1', 'u1', now() + interval '7 days', NULL),
        ('t2', 'h2', 'u1', now() + interval '7 days', now() - interval '1 hour'),
        ('t3', 'h3', 'u1', now() - interval '1 day', NULL),
        ('t4', 'h4', 'u2', now() + interval '7 days', NULL);
    `);

    await db.query(sqlOf(all[target]));

    const { rows } = await db.query<{
      id: string;
      familyId: string;
      revokedAt: Date | null;
      rotatedAt: Date | null;
      successorId: string | null;
      graceUsedAt: Date | null;
    }>(
      `SELECT id, "familyId", "revokedAt", "rotatedAt", "successorId", "graceUsedAt"
         FROM "RefreshToken" ORDER BY id`,
    );
    expect(rows.map((r) => r.id)).toEqual(['t1', 't2', 't3', 't4']);
    for (const row of rows) {
      expect(row.familyId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      // Nada é inventado: sem rotação, sucessor nem tolerância conhecidos.
      expect(row).toMatchObject({
        rotatedAt: null,
        successorId: null,
        graceUsedAt: null,
      });
    }
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(rows.length);
    // O estado antigo é preservado.
    expect(rows.find((r) => r.id === 't2')!.revokedAt).toBeInstanceOf(Date);

    const column = await db.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'RefreshToken' AND column_name = 'familyId'`,
      [schema],
    );
    expect(column.rows).toEqual([{ is_nullable: 'NO', data_type: 'uuid' }]);

    const index = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'RefreshToken_familyId_idx'`,
      [schema],
    );
    expect(index.rows).toHaveLength(1);

    await expect(
      db.query(`
        INSERT INTO "RefreshToken" (id, "tokenHash", "userId", "expiresAt")
        VALUES ('t5', 'h5', 'u1', now() + interval '7 days')`),
    ).rejects.toThrow(/familyId/);
  });
});
