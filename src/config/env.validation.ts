import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const TTL_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

/**
 * Inteiro positivo + unidade (s, m, h ou d). Número sem unidade fica de fora
 * de propósito: o jsonwebtoken (via `ms`) leria "15" como 15 milissegundos.
 */
const TTL_PATTERN = /^([1-9]\d*)([smhd])$/;

/** Tetos dos TTLs dos tokens (A-14), com o rótulo usado na mensagem de erro. */
export const ACCESS_TTL_MAX = { seconds: 3600, label: '1h' } as const;
export const REFRESH_TTL_MAX = { seconds: 30 * 86_400, label: '30d' } as const;

/** Teto da janela de tolerância do refresh token (A-04). */
export const REFRESH_GRACE_MAX_SECONDS = 60;

/** "15m" -> 900. `undefined` se o formato não for o aceito. */
export function ttlToSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TTL_PATTERN.exec(value);
  if (!match) return undefined;
  const unit = match[2] as keyof typeof TTL_UNIT_SECONDS;
  return Number(match[1]) * TTL_UNIT_SECONDS[unit];
}

/**
 * TTL no formato estrito e até o teto. A mensagem diz a variável e o motivo,
 * sem o valor (mesma regra das demais).
 */
function IsTtl(max: { seconds: number; label: string }): PropertyDecorator {
  return ValidateBy({
    name: 'isTtl',
    validator: {
      validate: (value) => {
        const seconds = ttlToSeconds(value);
        return seconds !== undefined && seconds <= max.seconds;
      },
      defaultMessage: (args) =>
        ttlToSeconds(args?.value) === undefined
          ? `${args?.property} deve ser um inteiro positivo seguido de s, m, h ou d (ex.: 15m, 7d); sem unidade, o jsonwebtoken leria o número como milissegundos`
          : `${args?.property} não pode passar de ${max.label}`,
    },
  });
}

/**
 * Contrato das variáveis de ambiente. Validado uma única vez no boot pelo
 * ConfigModule: se algo estiver faltando/inválido a aplicação nem sobe,
 * em vez de falhar horas depois numa request.
 *
 * Também serve como tipo para `ConfigService<EnvironmentVariables, true>`,
 * dando autocomplete e tipagem nos `config.get(...)`.
 */
export class EnvironmentVariables {
  // Sem default de propósito: esquecer o NODE_ENV em produção não pode cair
  // silenciosamente em "development" (cookie sem Secure, Swagger exposto).
  @IsEnum(NodeEnv, {
    message: `NODE_ENV é obrigatório e deve ser um de: ${Object.values(NodeEnv).join(', ')}`,
  })
  NODE_ENV: NodeEnv;

  @IsInt()
  @Min(0)
  PORT: number = 3000;

  @IsUrl({ require_tld: false })
  FRONTEND_URL: string;

  // Flag Secure do cookie do refresh token (fluxo web). Ligada por padrão e
  // independente de NODE_ENV; desligar só serve para dev em http:// num
  // browser que recusa Secure fora de HTTPS (Safari). Proibido em produção.
  @Transform(({ obj, key }) => parseBooleanFlag(obj[key]))
  @IsBoolean({ message: 'COOKIE_SECURE deve ser "true" ou "false"' })
  COOKIE_SECURE: boolean = true;

  // Log de eventos de segurança (A-07). Ligado por padrão; o .env.test o
  // desliga para não poluir a saída, e os testes do log o religam.
  @Transform(({ obj, key }) => parseBooleanFlag(obj[key]))
  @IsBoolean({ message: 'SECURITY_LOG_ENABLED deve ser "true" ou "false"' })
  SECURITY_LOG_ENABLED: boolean = true;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  // Segredos curtos tornam o JWT (HS256) vulnerável a força bruta. Em
  // produção a exigência é maior (ver checkProductionCredentials).
  @IsString()
  @MinLength(32)
  JWT_SECRET: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET: string;

  // Claim `iss` dos dois tokens, conferida no verify (A-14). Opcional; trocar
  // o valor invalida todos os tokens já emitidos.
  @IsString()
  @Matches(/^\S+$/, {
    message: 'JWT_ISSUER não pode ser vazio nem conter espaços',
  })
  @MaxLength(255, { message: 'JWT_ISSUER pode ter no máximo 255 caracteres' })
  JWT_ISSUER: string = 'dutrail-api';

  @IsTtl(ACCESS_TTL_MAX)
  JWT_ACCESS_TTL: string = '15m';

  @IsTtl(REFRESH_TTL_MAX)
  JWT_REFRESH_TTL: string = '7d';

  // Janela de tolerância (A-04): por quantos segundos um refresh token recém-
  // rotacionado ainda pode ser reapresentado uma vez (resposta perdida, duas
  // abas) sem contar como reuso. Curta de propósito: quem tiver uma cópia do
  // token também a aproveita. 0 desativa.
  @Transform(({ obj, key }) => parseNonNegativeInt(obj[key]))
  @ValidateBy({
    name: 'isGraceSeconds',
    validator: {
      validate: (value) =>
        Number.isInteger(value) &&
        (value as number) >= 0 &&
        (value as number) <= REFRESH_GRACE_MAX_SECONDS,
      defaultMessage: () =>
        `REFRESH_GRACE_SECONDS deve ser um inteiro de 0 a ${REFRESH_GRACE_MAX_SECONDS} (segundos; 0 desativa a janela de tolerância)`,
    },
  })
  REFRESH_GRACE_SECONDS: number = 30;

  @IsString()
  @IsNotEmpty()
  GOOGLE_CLIENT_ID: string;

  @IsString()
  @IsNotEmpty()
  GOOGLE_CLIENT_SECRET: string;

  @IsUrl({ require_tld: false })
  GOOGLE_CALLBACK_URL: string;

  // Object storage S3-compatível (hoje Oracle Cloud) onde ficam os .fit
  // originais. Qualquer provedor que fale a API do S3 serve.
  @IsUrl({ require_tld: false })
  OCI_S3_ENDPOINT: string;

  @IsString()
  @IsNotEmpty()
  OCI_S3_REGION: string;

  @IsString()
  @IsNotEmpty()
  OCI_S3_BUCKET: string;

  @IsString()
  @IsNotEmpty()
  OCI_S3_ACCESS_KEY: string;

  @IsString()
  @IsNotEmpty()
  OCI_S3_SECRET_KEY: string;

  // Checagem de senha vazada no cadastro (A-09), na API do Have I Been Pwned
  // por k-anonymity. Ligada por padrão; desligar só serve para rodar sem
  // acesso à internet. Se a API não responder no prazo, o cadastro segue.
  @Transform(({ obj, key }) => parseBooleanFlag(obj[key]))
  @IsBoolean({ message: 'BREACHED_PASSWORD_CHECK deve ser "true" ou "false"' })
  BREACHED_PASSWORD_CHECK: boolean = true;

  @IsInt({ message: 'BREACHED_PASSWORD_TIMEOUT_MS deve ser um inteiro' })
  @Min(100, { message: 'BREACHED_PASSWORD_TIMEOUT_MS deve ser de 100 a 10000' })
  @Max(10_000, {
    message: 'BREACHED_PASSWORD_TIMEOUT_MS deve ser de 100 a 10000',
  })
  BREACHED_PASSWORD_TIMEOUT_MS: number = 2000;

  @IsInt()
  @Min(1)
  THROTTLE_TTL_MS: number = 60_000;

  @IsInt()
  @Min(1)
  THROTTLE_LIMIT: number = 100;
}

/**
 * Trechos dos valores de exemplo do `.env.example`. Em produção, uma credencial
 * que contenha qualquer um deles é quase certamente o placeholder copiado —
 * e o placeholder é público no repositório. Comparação sem diferenciar
 * maiúsculas.
 */
export const PLACEHOLDER_FRAGMENTS = [
  'troque',
  'change',
  'example',
  'xxx',
  'secret',
  'senha',
] as const;

/** 256 bits em base64url (32 bytes -> 43 caracteres). */
export const PRODUCTION_JWT_SECRET_MIN_LENGTH = 43;

const JWT_SECRETS = ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;

/** Credenciais que têm placeholder no `.env.example`. */
const PLACEHOLDER_CHECKED_CREDENTIALS = [
  ...JWT_SECRETS,
  'DATABASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OCI_S3_ACCESS_KEY',
  'OCI_S3_SECRET_KEY',
] as const;

/**
 * Regras extras de produção. Em development/test valem só as do decorator
 * (os valores locais são frases legíveis, aceitáveis fora de produção).
 * As mensagens nunca incluem o valor da variável.
 */
function checkProductionCredentials(env: EnvironmentVariables): string[] {
  const problems: string[] = [];

  for (const name of JWT_SECRETS) {
    if (env[name].length < PRODUCTION_JWT_SECRET_MIN_LENGTH) {
      problems.push(
        `${name} precisa ter pelo menos ${PRODUCTION_JWT_SECRET_MIN_LENGTH} caracteres em produção (256 bits em base64url)`,
      );
    }
  }

  for (const name of PLACEHOLDER_CHECKED_CREDENTIALS) {
    const value = env[name].toLowerCase();
    const fragment = PLACEHOLDER_FRAGMENTS.find((f) => value.includes(f));
    if (fragment) {
      problems.push(
        `${name} contém o trecho de placeholder "${fragment}" (valor do .env.example?); em produção use a credencial real`,
      );
    }
  }

  return problems;
}

/** Credenciais do Google conferidas pelo aviso de desenvolvimento. */
const GOOGLE_CREDENTIALS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

/**
 * Avisos (não erros) sobre a configuração do Google fora de produção: um
 * placeholder do `.env.example` ou um GOOGLE_CALLBACK_URL que não aponta para a
 * rota do callback (`callbackPath`) fazem o login com Google falhar só no
 * Google, longe da causa. Em produção não há aviso: os placeholders já são
 * recusados no boot (checkProductionCredentials). Nunca inclui os valores.
 */
export function googleConfigWarnings(
  env: Pick<
    EnvironmentVariables,
    'NODE_ENV' | 'GOOGLE_CALLBACK_URL' | (typeof GOOGLE_CREDENTIALS)[number]
  >,
  callbackPath: string,
): string[] {
  if (env.NODE_ENV === NodeEnv.Production) return [];
  const warnings: string[] = [];

  for (const name of GOOGLE_CREDENTIALS) {
    const value = env[name].toLowerCase();
    const fragment = PLACEHOLDER_FRAGMENTS.find((f) => value.includes(f));
    if (fragment) {
      warnings.push(
        `${name} contém o trecho de placeholder "${fragment}" (valor do .env.example?); o login com Google vai falhar no Google`,
      );
    }
  }

  // O @IsUrl já garantiu uma URL; o try cobre o que ele aceita e o URL não.
  let path: string | undefined;
  try {
    path = new URL(env.GOOGLE_CALLBACK_URL).pathname;
  } catch {
    path = undefined;
  }
  if (path !== callbackPath) {
    warnings.push(
      `o caminho de GOOGLE_CALLBACK_URL não é ${callbackPath} (a rota do callback); o Google redirecionaria para uma rota que não existe`,
    );
  }

  return warnings;
}

/**
 * A conversão implícita faria `Boolean("false") === true`; aqui só "true" e
 * "false" viram booleano. Qualquer outro valor passa adiante e o @IsBoolean
 * o recusa.
 */
function parseBooleanFlag(raw: unknown): unknown {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return raw;
}

/**
 * Só dígitos viram número. A conversão implícita leria "" como 0 (o que
 * desligaria a janela sem aviso) e "1e1" como 10; o resto passa adiante e o
 * validador o recusa.
 */
function parseNonNegativeInt(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  return /^\d+$/.test(value) ? Number(value) : raw;
}

/**
 * Função plugada em `ConfigModule.forRoot({ validate })`. Recebe o
 * process.env cru (tudo string), converte para a classe acima e valida.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const env = plainToInstance(EnvironmentVariables, raw, {
    // Converte "3000" -> 3000 com base no tipo declarado na propriedade.
    enableImplicitConversion: true,
    // Mantém valores padrão declarados na classe quando a variável não existe.
    exposeDefaultValues: true,
  });

  const errors = validateSync(env, {
    skipMissingProperties: false,
    // Os erros não carregam o valor nem o objeto: nada de segredo em log.
    validationError: { target: false, value: false },
  });
  if (errors.length > 0) {
    throw invalidEnvError(
      errors.map((e) => Object.values(e.constraints ?? {}).join(', ')),
    );
  }

  const problems: string[] = [];

  // Usar o mesmo segredo para os dois tokens permitiria apresentar um refresh
  // token como access token (e vice-versa).
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push('JWT_SECRET e JWT_REFRESH_SECRET precisam ser diferentes');
  }

  if (env.NODE_ENV === NodeEnv.Production) {
    problems.push(...checkProductionCredentials(env));
    if (!env.COOKIE_SECURE) {
      problems.push(
        'COOKIE_SECURE não pode ser desligado em produção: sem a flag Secure o refresh token trafegaria também por HTTP',
      );
    }
  }

  if (problems.length > 0) {
    throw invalidEnvError(problems);
  }

  return env;
}

function invalidEnvError(details: string[]): Error {
  return new Error(
    `Variáveis de ambiente inválidas:\n  - ${details.join('\n  - ')}`,
  );
}
