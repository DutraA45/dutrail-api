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
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(0)
  PORT: number = 3000;

  @IsUrl({ require_tld: false })
  FRONTEND_URL: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  // Segredos curtos tornam o JWT (HS256) vulnerável a força bruta.
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

  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('\n  - ');
    throw new Error(`Variáveis de ambiente inválidas:\n  - ${details}`);
  }

  // Usar o mesmo segredo para os dois tokens permitiria apresentar um refresh
  // token como access token (e vice-versa).
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET e JWT_REFRESH_SECRET precisam ser diferentes');
  }

  return env;
}
