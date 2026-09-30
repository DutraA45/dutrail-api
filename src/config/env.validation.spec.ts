import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  NodeEnv,
  PLACEHOLDER_FRAGMENTS,
  PRODUCTION_JWT_SECRET_MIN_LENGTH,
  validateEnv,
} from './env.validation.js';

function loadEnvFile(path: string): Record<string, string> {
  return parse(readFileSync(path));
}

// Os arquivos versionados: o .env local de dev é uma cópia editada do
// .env.example, e o .env.test é o que os e2e usam. O endpoint do .env.example
// tem "<namespace>" literal (não é URL válida), então é preenchido como no
// .env de dev; o resto — inclusive os segredos placeholder — fica como está.
const exampleEnv: Record<string, string> = {
  ...loadEnvFile('.env.example'),
  OCI_S3_ENDPOINT:
    'https://axbc12.compat.objectstorage.sa-saopaulo-1.oraclecloud.com',
};
const testEnv = loadEnvFile('.env.test');

/**
 * Mesmo comando documentado no .env.example. Um valor aleatório pode conter
 * um trecho de placeholder por acaso (ex.: "xXx", ~0,2% das vezes); descarta
 * esses para o teste não ser intermitente.
 */
function randomSecret(): string {
  for (;;) {
    const secret = randomBytes(48).toString('base64url');
    const lower = secret.toLowerCase();
    if (!PLACEHOLDER_FRAGMENTS.some((f) => lower.includes(f))) return secret;
  }
}

/** Configuração de produção plausível, sem nenhum placeholder. */
function productionEnv(): Record<string, string> {
  return {
    ...exampleEnv,
    NODE_ENV: NodeEnv.Production,
    FRONTEND_URL: 'https://dutrail.app',
    DATABASE_URL:
      'postgresql://dutrail_owner:npg_Q7vRk2Lm9Tz@ep-cool-lake-123456.sa-east-1.aws.neon.tech/dutrail?sslmode=require',
    JWT_SECRET: randomSecret(),
    JWT_REFRESH_SECRET: randomSecret(),
    GOOGLE_CLIENT_ID:
      '123456789012-a1b2c3d4e5f6g7h8.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-Q7vRk2Lm9TzA4bN8wYp3',
    GOOGLE_CALLBACK_URL: 'https://api.dutrail.app/auth/google/callback',
    OCI_S3_ENDPOINT:
      'https://axbc12.compat.objectstorage.sa-saopaulo-1.oraclecloud.com',
    OCI_S3_ACCESS_KEY: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    OCI_S3_SECRET_KEY: 'Q7vRk2Lm9TzA4bN8wYp3Hs6Dj1Fg0Kc5Ue7Io2Pa=',
  };
}

function validationMessage(raw: Record<string, unknown>): string {
  try {
    validateEnv(raw);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('esperava que a validação falhasse');
}

describe('validateEnv', () => {
  describe('NODE_ENV', () => {
    it('falha quando ausente (não assume development)', () => {
      const { NODE_ENV: _omitted, ...withoutNodeEnv } = exampleEnv;

      expect(validationMessage(withoutNodeEnv)).toMatch(
        /NODE_ENV é obrigatório/,
      );
    });

    it('falha com valor fora da lista', () => {
      expect(validationMessage({ ...exampleEnv, NODE_ENV: 'staging' })).toMatch(
        /NODE_ENV é obrigatório e deve ser um de: development, test, production/,
      );
    });
  });

  describe('development e test (regras atuais)', () => {
    it('development aceita os valores do .env.example', () => {
      const env = validateEnv({ ...exampleEnv, NODE_ENV: 'development' });

      expect(env.NODE_ENV).toBe(NodeEnv.Development);
    });

    it('test aceita os valores do .env.test', () => {
      expect(validateEnv(testEnv).NODE_ENV).toBe(NodeEnv.Test);
    });

    it('continua exigindo 32 caracteres nos segredos JWT', () => {
      expect(
        validationMessage({ ...exampleEnv, JWT_SECRET: 'curto-demais' }),
      ).toMatch(/JWT_SECRET must be longer than or equal to 32 characters/);
    });

    it('continua exigindo segredos JWT diferentes', () => {
      expect(
        validationMessage({
          ...exampleEnv,
          JWT_REFRESH_SECRET: exampleEnv.JWT_SECRET,
        }),
      ).toMatch(/JWT_SECRET e JWT_REFRESH_SECRET precisam ser diferentes/);
    });
  });

  describe('production', () => {
    it('aceita segredos aleatórios de 48 bytes em base64url', () => {
      const env = validateEnv(productionEnv());

      expect(env.NODE_ENV).toBe(NodeEnv.Production);
    });

    it('recusa o .env.example copiado, apontando cada credencial', () => {
      const message = validationMessage({
        ...exampleEnv,
        NODE_ENV: 'production',
      });

      for (const name of [
        'JWT_SECRET',
        'JWT_REFRESH_SECRET',
        'DATABASE_URL',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'OCI_S3_ACCESS_KEY',
        'OCI_S3_SECRET_KEY',
      ]) {
        expect(message).toMatch(
          new RegExp(`${name} contém o trecho de placeholder`),
        );
      }
    });

    it.each(PLACEHOLDER_FRAGMENTS)(
      'recusa JWT_SECRET contendo "%s", mesmo em maiúsculas',
      (fragment) => {
        const secret = `${randomSecret()}${fragment.toUpperCase()}`;

        expect(
          validationMessage({ ...productionEnv(), JWT_SECRET: secret }),
        ).toMatch(`JWT_SECRET contém o trecho de placeholder "${fragment}"`);
      },
    );

    it('recusa GOOGLE_CLIENT_SECRET com placeholder', () => {
      expect(
        validationMessage({
          ...productionEnv(),
          GOOGLE_CLIENT_SECRET: 'GOCSPX-xxxx',
        }),
      ).toMatch(/GOOGLE_CLIENT_SECRET contém o trecho de placeholder "xxx"/);
    });

    it(`exige ${PRODUCTION_JWT_SECRET_MIN_LENGTH} caracteres nos segredos JWT`, () => {
      const shortSecret = randomBytes(24).toString('base64url'); // 32 chars

      expect(
        validationMessage({
          ...productionEnv(),
          JWT_REFRESH_SECRET: shortSecret,
        }),
      ).toMatch(
        /JWT_REFRESH_SECRET precisa ter pelo menos 43 caracteres em produção/,
      );
    });

    it('exige segredos JWT diferentes', () => {
      const env = productionEnv();

      expect(
        validationMessage({ ...env, JWT_REFRESH_SECRET: env.JWT_SECRET }),
      ).toMatch(/JWT_SECRET e JWT_REFRESH_SECRET precisam ser diferentes/);
    });

    it('nunca inclui o valor dos segredos na mensagem de erro', () => {
      const env = {
        ...productionEnv(),
        JWT_SECRET: `${randomSecret()}troque`,
        JWT_REFRESH_SECRET: 'curto',
      };

      const message = validationMessage(env);

      expect(message).not.toContain(env.JWT_SECRET);
      expect(message).not.toContain(env.JWT_REFRESH_SECRET);
    });
  });
});
