import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
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

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL: string = '15m';

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_TTL: string = '7d';

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
