import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { AuthController } from '../auth/auth.controller.js';
import { GOOGLE_CALLBACK_PATH } from '../auth/google-callback.js';
import {
  googleConfigWarnings,
  LOGIN_FAILURE_WINDOW_MINUTES_RANGE,
  LOGIN_MAX_FAILURES_RANGE,
  NodeEnv,
  PLACEHOLDER_FRAGMENTS,
  PRODUCTION_JWT_SECRET_MIN_LENGTH,
  REFRESH_GRACE_MAX_SECONDS,
  parseTrustProxy,
  schedulerEnabled,
  TRUST_PROXY_MAX_HOPS,
  validateEnv,
} from './env.validation.js';

function loadEnvFile(path: string): Record<string, string> {
  return parse(readFileSync(path));
}

// Os arquivos versionados, sem ajustes: o .env local de dev é uma cópia
// editada do .env.example, e o .env.test é o que os e2e usam.
const exampleEnv = loadEnvFile('.env.example');
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
    it('development aceita o .env.example como está', () => {
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

  describe('COOKIE_SECURE', () => {
    const { COOKIE_SECURE: _omitted, ...withoutCookieSecure } = exampleEnv;

    it('é true por padrão (variável ausente), em qualquer NODE_ENV', () => {
      for (const nodeEnv of Object.values(NodeEnv)) {
        const raw =
          nodeEnv === NodeEnv.Production
            ? { ...productionEnv(), COOKIE_SECURE: undefined }
            : { ...withoutCookieSecure, NODE_ENV: nodeEnv };

        expect(validateEnv(raw).COOKIE_SECURE).toBe(true);
      }
    });

    it.each([
      ['true', true],
      ['false', false],
      [' FALSE ', false],
    ])('development aceita "%s"', (value, expected) => {
      expect(
        validateEnv({ ...exampleEnv, COOKIE_SECURE: value }).COOKIE_SECURE,
      ).toBe(expected);
    });

    it('test aceita false (o .env.test desliga o Secure)', () => {
      expect(validateEnv(testEnv).COOKIE_SECURE).toBe(false);
    });

    it.each(['yes', '0', '1', ''])(
      'recusa "%s": só true ou false (Boolean("false") seria true)',
      (value) => {
        expect(
          validationMessage({ ...exampleEnv, COOKIE_SECURE: value }),
        ).toMatch(/COOKIE_SECURE deve ser "true" ou "false"/);
      },
    );

    it('production aceita true', () => {
      expect(
        validateEnv({ ...productionEnv(), COOKIE_SECURE: 'true' })
          .COOKIE_SECURE,
      ).toBe(true);
    });

    it('production recusa false, dizendo a variável e o motivo sem valores', () => {
      const message = validationMessage({
        ...productionEnv(),
        COOKIE_SECURE: 'false',
      });

      expect(message).toMatch(
        /COOKIE_SECURE não pode ser desligado em produção: sem a flag Secure o refresh token trafegaria também por HTTP/,
      );
      expect(message).not.toMatch(/false/i);
    });
  });

  describe('SECURITY_LOG_ENABLED', () => {
    const { SECURITY_LOG_ENABLED: _omitted, ...withoutFlag } = exampleEnv;

    it('é true por padrão (variável ausente)', () => {
      expect(validateEnv(withoutFlag).SECURITY_LOG_ENABLED).toBe(true);
    });

    it('o .env.example liga e o .env.test desliga', () => {
      expect(validateEnv(exampleEnv).SECURITY_LOG_ENABLED).toBe(true);
      expect(validateEnv(testEnv).SECURITY_LOG_ENABLED).toBe(false);
    });

    it.each(['yes', '0', ''])('recusa "%s": só true ou false', (value) => {
      expect(
        validationMessage({ ...exampleEnv, SECURITY_LOG_ENABLED: value }),
      ).toMatch(/SECURITY_LOG_ENABLED deve ser "true" ou "false"/);
    });
  });

  describe('SCHEDULER_ENABLED', () => {
    const { SCHEDULER_ENABLED: _omitted, ...withoutFlag } = exampleEnv;

    it('é true por padrão (variável ausente)', () => {
      expect(validateEnv(withoutFlag).SCHEDULER_ENABLED).toBe(true);
    });

    it('o .env.example liga e o .env.test desliga', () => {
      expect(validateEnv(exampleEnv).SCHEDULER_ENABLED).toBe(true);
      expect(validateEnv(testEnv).SCHEDULER_ENABLED).toBe(false);
    });

    it.each(['yes', '0', ''])('recusa "%s": só true ou false', (value) => {
      expect(
        validationMessage({ ...exampleEnv, SCHEDULER_ENABLED: value }),
      ).toMatch(/SCHEDULER_ENABLED deve ser "true" ou "false"/);
    });

    it('schedulerEnabled (AppModule) lê o env cru como a validação', () => {
      expect(schedulerEnabled({})).toBe(true);
      expect(schedulerEnabled({ SCHEDULER_ENABLED: 'true' })).toBe(true);
      expect(schedulerEnabled({ SCHEDULER_ENABLED: ' TRUE ' })).toBe(true);
      expect(schedulerEnabled({ SCHEDULER_ENABLED: 'false' })).toBe(false);
      expect(schedulerEnabled({ SCHEDULER_ENABLED: ' False' })).toBe(false);
      expect(schedulerEnabled(testEnv)).toBe(false);
    });
  });

  describe('JWT_ACCESS_TTL e JWT_REFRESH_TTL', () => {
    it('os arquivos versionados usam 15m e 7d, e o padrão é o mesmo', () => {
      for (const file of [exampleEnv, testEnv]) {
        expect(file).toMatchObject({
          JWT_ACCESS_TTL: '15m',
          JWT_REFRESH_TTL: '7d',
        });
      }
      const {
        JWT_ACCESS_TTL: _access,
        JWT_REFRESH_TTL: _refresh,
        ...withoutTtls
      } = exampleEnv;
      expect(validateEnv(withoutTtls)).toMatchObject({
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_TTL: '7d',
      });
    });

    it.each([
      ['JWT_ACCESS_TTL', '30s'],
      ['JWT_ACCESS_TTL', '59m'],
      ['JWT_ACCESS_TTL', '1h'],
      ['JWT_ACCESS_TTL', '3600s'],
      ['JWT_REFRESH_TTL', '12h'],
      ['JWT_REFRESH_TTL', '3d'],
      ['JWT_REFRESH_TTL', '30d'],
      ['JWT_REFRESH_TTL', '720h'],
    ] as const)('%s aceita "%s"', (name, value) => {
      expect(validateEnv({ ...exampleEnv, [name]: value })[name]).toBe(value);
    });

    it.each([
      ['JWT_ACCESS_TTL', '15'],
      ['JWT_REFRESH_TTL', '604800'],
      ['JWT_ACCESS_TTL', '0m'],
      ['JWT_ACCESS_TTL', '-5m'],
      ['JWT_ACCESS_TTL', '1.5h'],
      ['JWT_ACCESS_TTL', '15 m'],
      ['JWT_ACCESS_TTL', '15min'],
      ['JWT_REFRESH_TTL', '1w'],
      ['JWT_REFRESH_TTL', '7D'],
      ['JWT_REFRESH_TTL', ''],
    ])('%s recusa "%s" (formato)', (name, value) => {
      const message = validationMessage({ ...exampleEnv, [name]: value });

      expect(message).toContain(
        `${name} deve ser um inteiro positivo seguido de s, m, h ou d`,
      );
      expect(message).toContain('milissegundos');
    });

    it.each([
      ['JWT_ACCESS_TTL', '61m', '1h'],
      ['JWT_ACCESS_TTL', '2h', '1h'],
      ['JWT_ACCESS_TTL', '3601s', '1h'],
      ['JWT_ACCESS_TTL', '1d', '1h'],
      ['JWT_REFRESH_TTL', '31d', '30d'],
      ['JWT_REFRESH_TTL', '721h', '30d'],
      ['JWT_REFRESH_TTL', '99999999999999999999d', '30d'],
    ])('%s recusa "%s" (acima de %s)', (name, value, max) => {
      expect(validationMessage({ ...exampleEnv, [name]: value })).toContain(
        `${name} não pode passar de ${max}`,
      );
    });

    it('aponta as duas variáveis quando ambas falham, sem segredos na mensagem', () => {
      const message = validationMessage({
        ...exampleEnv,
        JWT_ACCESS_TTL: '15',
        JWT_REFRESH_TTL: '90d',
      });

      expect(message).toContain('JWT_ACCESS_TTL deve ser um inteiro positivo');
      expect(message).toContain('JWT_REFRESH_TTL não pode passar de 30d');
      expect(message).not.toContain(exampleEnv.JWT_SECRET);
      expect(message).not.toContain(exampleEnv.JWT_REFRESH_SECRET);
    });
  });

  describe('REFRESH_GRACE_SECONDS', () => {
    const { REFRESH_GRACE_SECONDS: _omitted, ...withoutGrace } = exampleEnv;

    it('é 30 por padrão (variável ausente), e os arquivos versionados usam 30', () => {
      expect(validateEnv(withoutGrace).REFRESH_GRACE_SECONDS).toBe(30);
      expect(validateEnv(exampleEnv).REFRESH_GRACE_SECONDS).toBe(30);
      expect(validateEnv(testEnv).REFRESH_GRACE_SECONDS).toBe(30);
    });

    it.each([
      ['0', 0],
      ['1', 1],
      ['60', 60],
      [' 45 ', 45],
    ])('aceita "%s"', (value, expected) => {
      expect(
        validateEnv({ ...exampleEnv, REFRESH_GRACE_SECONDS: value })
          .REFRESH_GRACE_SECONDS,
      ).toBe(expected);
    });

    // "" e "1e1" passariam pela conversão implícita (0 e 10).
    it.each(['61', '-1', '1.5', '30s', 'abc', '', '1e1', '0x1f'])(
      'recusa "%s" com a regra, sem repetir o valor',
      (value) => {
        const message = validationMessage({
          ...exampleEnv,
          REFRESH_GRACE_SECONDS: value,
        });
        expect(message).toContain(
          `REFRESH_GRACE_SECONDS deve ser um inteiro de 0 a ${REFRESH_GRACE_MAX_SECONDS} (segundos; 0 desativa a janela de tolerância)`,
        );
        // Uma linha só para a variável, e nenhum valor recebido no texto.
        expect(message.match(/REFRESH_GRACE_SECONDS/g)).toHaveLength(1);
        if (value.trim() !== '') {
          expect(message).not.toContain(`"${value}"`);
        }
        expect(message).not.toContain(exampleEnv.JWT_SECRET);
      },
    );
  });

  describe('TRUST_PROXY', () => {
    const { TRUST_PROXY: _omitted, ...withoutTrustProxy } = exampleEnv;
    const trustProxy = (value: string) =>
      validateEnv({ ...exampleEnv, TRUST_PROXY: value }).TRUST_PROXY;

    it('é desligado por padrão (variável ausente), e os arquivos versionados o deixam vazio', () => {
      expect(validateEnv(withoutTrustProxy).TRUST_PROXY).toBe(false);
      expect(exampleEnv.TRUST_PROXY).toBe('');
      expect(testEnv.TRUST_PROXY).toBe('');
      expect(validateEnv(exampleEnv).TRUST_PROXY).toBe(false);
      expect(validateEnv(testEnv).TRUST_PROXY).toBe(false);
    });

    it.each(['', '  ', 'false', 'FALSE', ' False '])(
      'aceita "%s" como desligado',
      (value) => {
        expect(trustProxy(value)).toBe(false);
      },
    );

    // Number, não string: o Express leria a string "1" como um IP.
    it.each([
      ['1', 1],
      ['2', 2],
      [' 3 ', 3],
      [String(TRUST_PROXY_MAX_HOPS), TRUST_PROXY_MAX_HOPS],
    ])('aceita "%s" saltos como number', (value, expected) => {
      expect(trustProxy(value)).toBe(expected);
    });

    it.each([
      ['10.0.0.5', ['10.0.0.5']],
      ['10.0.0.0/8', ['10.0.0.0/8']],
      ['192.168.1.10, 10.0.0.0/16', ['192.168.1.10', '10.0.0.0/16']],
      ['::1', ['::1']],
      ['2001:db8::/32', ['2001:db8::/32']],
      ['::ffff:10.0.0.0/104', ['::ffff:10.0.0.0/104']],
      ['loopback', ['loopback']],
      [
        'Loopback, LinkLocal, uniquelocal',
        ['loopback', 'linklocal', 'uniquelocal'],
      ],
      ['loopback,10.0.0.1', ['loopback', '10.0.0.1']],
      ['10.0.0.1/32', ['10.0.0.1/32']],
    ])('aceita a lista "%s"', (value, expected) => {
      expect(trustProxy(value)).toEqual(expected);
    });

    function expectRejected(value: string, reason: RegExp) {
      const message = validationMessage({ ...exampleEnv, TRUST_PROXY: value });
      expect(message).toMatch(/TRUST_PROXY /);
      expect(message).toMatch(reason);
      // Uma linha só para a variável, e nenhum valor recebido no texto.
      expect(message.match(/TRUST_PROXY/g)).toHaveLength(1);
      for (const part of value.split(/[\s,]+/).filter((p) => p.length > 1)) {
        if (!['true', 'false'].includes(part.toLowerCase())) {
          expect(message).not.toContain(part);
        }
      }
      expect(message).not.toContain(exampleEnv.JWT_SECRET);
    }

    it.each(['true', 'TRUE', ' True ', '*', '10.0.0.1, *', 'loopback,true'])(
      'recusa "%s" (confiaria em todos)',
      (value) => {
        expectRejected(value, /não aceita "true" nem "\*".*forjável/);
      },
    );

    it.each([
      '0.0.0.0/0',
      '::/0',
      '::ffff:0:0/96', // todo o IPv4, pelos endereços IPv4-mapped
      '::/80', // contém ::ffff:0:0/96
      '10.0.0.1, 0.0.0.0/0',
    ])('recusa a faixa "%s" (cobre todos os endereços)', (value) => {
      expectRejected(value, /cobre todos os endereços.*forjável/);
    });

    it.each(['0', '11', '99', '007x'])(
      'recusa "%s" saltos fora da faixa ou malformados',
      (value) => {
        const message = validationMessage({
          ...exampleEnv,
          TRUST_PROXY: value,
        });
        expect(message).toMatch(/TRUST_PROXY /);
        if (/^\d+$/.test(value)) {
          expect(message).toContain(
            `TRUST_PROXY com número de saltos deve ser um inteiro de 1 a ${TRUST_PROXY_MAX_HOPS}`,
          );
        }
      },
    );

    it.each([
      ['1.5', /não é IP, CIDR nem um dos nomes/],
      ['-1', /não é IP, CIDR nem um dos nomes/],
      ['010.0.0.1', /não é IP, CIDR nem um dos nomes/],
      ['meu-proxy.local', /não é IP, CIDR nem um dos nomes/],
      ['fe80::1%eth0', /não é IP, CIDR nem um dos nomes/],
      ['all', /não é IP, CIDR nem um dos nomes/],
      ['10.0.0.0/33', /prefixo inválido/],
      ['10.0.0.0/255.0.0.0', /prefixo inválido/],
      ['10.0.0.0/', /prefixo inválido/],
      ['10.0.0.0/8/1', /não é IP, CIDR nem um dos nomes/],
      ['10.0.0.1,', /entrada vazia/],
      ['10.0.0.1,,10.0.0.2', /entrada vazia/],
    ])('recusa "%s" com o motivo, sem repetir o valor', (value, reason) => {
      expectRejected(value, reason);
    });

    it('parseTrustProxy aceita o valor ausente e recusa não-texto', () => {
      expect(parseTrustProxy(undefined)).toEqual({ ok: true, value: false });
      expect(parseTrustProxy(1)).toMatchObject({ ok: false });
    });
  });

  describe('LOGIN_MAX_FAILURES e LOGIN_FAILURE_WINDOW_MINUTES', () => {
    const {
      LOGIN_MAX_FAILURES: _max,
      LOGIN_FAILURE_WINDOW_MINUTES: _window,
      ...withoutLoginLimit
    } = exampleEnv;

    it('são 5 e 15 por padrão (variáveis ausentes), e os arquivos versionados usam os mesmos', () => {
      for (const env of [withoutLoginLimit, exampleEnv, testEnv]) {
        const parsed = validateEnv(env);
        expect(parsed.LOGIN_MAX_FAILURES).toBe(5);
        expect(parsed.LOGIN_FAILURE_WINDOW_MINUTES).toBe(15);
      }
    });

    it('aceitam os extremos das faixas', () => {
      for (const [name, range] of [
        ['LOGIN_MAX_FAILURES', LOGIN_MAX_FAILURES_RANGE],
        ['LOGIN_FAILURE_WINDOW_MINUTES', LOGIN_FAILURE_WINDOW_MINUTES_RANGE],
      ] as const) {
        for (const value of [range.min, range.max]) {
          expect(
            validateEnv({ ...exampleEnv, [name]: ` ${value} ` })[name],
          ).toBe(value);
        }
      }
    });

    it.each([
      [
        'LOGIN_MAX_FAILURES',
        `de ${LOGIN_MAX_FAILURES_RANGE.min} a ${LOGIN_MAX_FAILURES_RANGE.max} (falhas)`,
      ],
      [
        'LOGIN_FAILURE_WINDOW_MINUTES',
        `de ${LOGIN_FAILURE_WINDOW_MINUTES_RANGE.min} a ${LOGIN_FAILURE_WINDOW_MINUTES_RANGE.max} (minutos)`,
      ],
    ])('%s recusa valores fora da faixa ou malformados', (name, rule) => {
      for (const value of ['0', '101', '-1', '1.5', '15m', '', '1e1', 'abc']) {
        const message = validationMessage({ ...exampleEnv, [name]: value });
        expect(message, value).toContain(`${name} deve ser um inteiro ${rule}`);
        expect(message.match(new RegExp(name, 'g')), value).toHaveLength(1);
      }
    });
  });

  describe('JWT_ISSUER', () => {
    it('é dutrail-api por padrão (variável ausente)', () => {
      expect(validateEnv(exampleEnv).JWT_ISSUER).toBe('dutrail-api');
      expect(validateEnv(testEnv).JWT_ISSUER).toBe('dutrail-api');
    });

    it('aceita outro valor', () => {
      expect(
        validateEnv({ ...exampleEnv, JWT_ISSUER: 'https://api.dutrail.app' })
          .JWT_ISSUER,
      ).toBe('https://api.dutrail.app');
    });

    it.each(['', 'dutrail api', ' '])('recusa "%s"', (value) => {
      expect(validationMessage({ ...exampleEnv, JWT_ISSUER: value })).toContain(
        'JWT_ISSUER não pode ser vazio nem conter espaços',
      );
    });

    it('recusa valor com mais de 255 caracteres', () => {
      expect(
        validationMessage({ ...exampleEnv, JWT_ISSUER: 'a'.repeat(256) }),
      ).toContain('JWT_ISSUER pode ter no máximo 255 caracteres');
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

describe('googleConfigWarnings (aviso de desenvolvimento)', () => {
  const realLooking = {
    NODE_ENV: NodeEnv.Development,
    GOOGLE_CLIENT_ID:
      '123456789012-a1b2c3d4e5f6g7h8.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-Q7vRk2Lm9TzA4bN8wYp3',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
  };
  const warn = (overrides: Partial<typeof realLooking>) =>
    googleConfigWarnings(
      { ...realLooking, ...overrides },
      GOOGLE_CALLBACK_PATH,
    );

  it('o caminho conferido é exatamente a rota do callback no controller', () => {
    const controllerPath = Reflect.getMetadata(
      PATH_METADATA,
      AuthController,
    ) as string;
    // O Nest guarda o path do método na própria função do handler.
    const handler = Object.getOwnPropertyDescriptor(
      AuthController.prototype,
      'googleCallback',
    )?.value as object;
    const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string;
    expect(GOOGLE_CALLBACK_PATH).toBe(`/${controllerPath}/${methodPath}`);
  });

  it.each([NodeEnv.Development, NodeEnv.Test])(
    'nada a avisar com credenciais plausíveis e o callback certo (%s)',
    (nodeEnv) => {
      expect(warn({ NODE_ENV: nodeEnv })).toEqual([]);
    },
  );

  it.each(PLACEHOLDER_FRAGMENTS)(
    'avisa placeholder "%s" no GOOGLE_CLIENT_ID e no GOOGLE_CLIENT_SECRET',
    (fragment) => {
      const id = `123-${fragment.toUpperCase()}.apps.googleusercontent.com`;
      const secret = `GOCSPX-${fragment}-abc`;
      const warnings = warn({
        GOOGLE_CLIENT_ID: id,
        GOOGLE_CLIENT_SECRET: secret,
      });

      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(
        new RegExp(
          `^GOOGLE_CLIENT_ID contém o trecho de placeholder "${fragment}"`,
        ),
      );
      expect(warnings[1]).toMatch(/^GOOGLE_CLIENT_SECRET contém/);
      // Diz qual variável e por quê, nunca o valor.
      expect(warnings.join('\n')).not.toContain(id);
      expect(warnings.join('\n')).not.toContain(secret);
    },
  );

  it.each([
    ['outra rota', 'http://localhost:3000/auth/google/redirect'],
    ['barra no fim', 'http://localhost:3000/auth/google/callback/'],
    ['prefixo', 'http://localhost:3000/api/auth/google/callback'],
    ['só o host', 'http://localhost:3000'],
  ])('avisa GOOGLE_CALLBACK_URL com %s', (_label, url) => {
    const warnings = warn({ GOOGLE_CALLBACK_URL: url });
    expect(warnings).toEqual([
      'o caminho de GOOGLE_CALLBACK_URL não é /auth/google/callback (a rota do callback); o Google redirecionaria para uma rota que não existe',
    ]);
    expect(warnings[0]).not.toContain(url);
  });

  it('aceita qualquer host/porta com o caminho exato', () => {
    expect(
      warn({
        GOOGLE_CALLBACK_URL: 'https://api.dutrail.app/auth/google/callback',
      }),
    ).toEqual([]);
  });

  it('não avisa em produção (lá o boot já recusa os placeholders)', () => {
    expect(
      warn({
        NODE_ENV: NodeEnv.Production,
        GOOGLE_CLIENT_ID: 'xxx',
        GOOGLE_CALLBACK_URL: 'https://api.dutrail.app/outra',
      }),
    ).toEqual([]);
  });

  it('o .env.example dispara o aviso das duas credenciais, mas não o do callback', () => {
    const warnings = googleConfigWarnings(
      {
        NODE_ENV: NodeEnv.Development,
        GOOGLE_CLIENT_ID: exampleEnv.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: exampleEnv.GOOGLE_CLIENT_SECRET,
        GOOGLE_CALLBACK_URL: exampleEnv.GOOGLE_CALLBACK_URL,
      },
      GOOGLE_CALLBACK_PATH,
    );
    expect(warnings.map((w) => w.split(' ')[0])).toEqual([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]);
  });
});
