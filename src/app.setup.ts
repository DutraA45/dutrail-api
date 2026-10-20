import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import type { CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface.js';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Request, RequestHandler } from 'express';
import helmet from 'helmet';
import { GOOGLE_CALLBACK_PATH } from './auth/google-callback.js';
import { API_PREFIX } from './common/api-prefix.js';
import {
  EnvironmentVariables,
  googleConfigWarnings,
  NodeEnv,
} from './config/env.validation.js';

/**
 * Onde o Swagger é montado, abaixo do prefixo global: UI em /api/docs (e
 * assets em /api/docs/*), JSON em /api/docs-json.
 */
export const SWAGGER_PATH = 'docs';

/** O Swagger (UI e JSON) só é montado fora de produção. */
export function shouldSetupSwagger(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== NodeEnv.Production;
}

/** Rotas servidas pelo Swagger que recebem a CSP própria da UI. */
export function isSwaggerPath(path: string): boolean {
  const base = `/${API_PREFIX}/${SWAGGER_PATH}`;
  return (
    path === base || path.startsWith(`${base}/`) || path === `${base}-json`
  );
}

/**
 * Cabeçalhos de segurança. O helmet tira o `X-Powered-By` e manda
 * nosniff, Referrer-Policy: no-referrer, COOP/CORP same-origin etc.
 *
 * - HSTS: 1 ano com subdomínios, sem preload (preload é difícil de desfazer).
 *   Se um proxy reverso também emitir HSTS, use o mesmo valor.
 * - CSP: a padrão do helmet, com `frame-ancestors 'none'` (a API nunca é
 *   emoldurada). O `X-Frame-Options: DENY` cobre browsers sem CSP nível 2.
 * - CORP same-origin (padrão) não afeta o frontend: ele chama a API com fetch
 *   em modo CORS, e o browser só aplica o CORP a requests no-cors (<img>,
 *   <script>...).
 */
function securityHeaders(swaggerEnabled: boolean): RequestHandler {
  const common = {
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: false,
    },
    xFrameOptions: { action: 'deny' },
  } as const;

  const api = helmet({
    ...common,
    contentSecurityPolicy: {
      directives: { 'frame-ancestors': ["'none'"] },
    },
  });
  if (!swaggerEnabled) return api;

  // A Swagger UI carrega só scripts do próprio /api/docs (script-src 'self' basta)
  // e usa <style> inline, que a padrão já permite. A única diferença é sem
  // `upgrade-insecure-requests`: fora de produção a UI roda em http://, e o
  // upgrade mandaria os assets e o "Try it out" para https:// (que não existe).
  const docs = helmet({
    ...common,
    contentSecurityPolicy: {
      directives: {
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': null,
      },
    },
  });
  return (req: Request, res, next) =>
    isSwaggerPath(req.path) ? docs(req, res, next) : api(req, res, next);
}

/**
 * Configuração da aplicação que não cabe em módulos (prefixo global, cabeçalhos
 * de segurança, pipes globais, CORS, Swagger). Fica separada do main.ts para os
 * testes e2e subirem a app exatamente como em produção.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<EnvironmentVariables, true>);
  warnAboutGoogleConfig(config);
  const swaggerEnabled = shouldSetupSwagger(
    config.get('NODE_ENV', { infer: true }),
  );

  // Todas as rotas (inclusive o health check e o callback do Google) ficam
  // sob /api. Sem exceções; as rotas sem prefixo respondem 404.
  app.setGlobalPrefix(API_PREFIX);

  // Primeiro middleware: vale para toda resposta, inclusive 401/404 e erros.
  app.use(securityHeaders(swaggerEnabled));

  // Popula `req.cookies`, de onde o fluxo web lê o refresh token. Sem segredo
  // de assinatura: o valor é um JWT, que já carrega a própria integridade.
  app.use(cookieParser());

  // Descarta campos que não estão no DTO (whitelist) e rejeita a request se
  // vierem campos desconhecidos (forbidNonWhitelisted). `transform` aplica os
  // @Transform() dos DTOs e converte tipos primitivos.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS só para as origens de CORS_ORIGINS (ex.: o `ng serve` em
  // localhost:4200 no dev). Quando frontend e API estão na mesma origem, a
  // lista fica vazia: as requests do frontend nem são cross-origin, e nenhum
  // outro site recebe Access-Control-Allow-Origin. Requests sem Origin (app
  // nativo, curl) passam igual nos dois casos: o CORS só decide quais headers
  // vão na resposta.
  //
  // `credentials: true` é obrigatório para o cookie httpOnly do refresh token
  // cross-origin: sem ele o browser não envia o cookie nem aceita o
  // Set-Cookie. A origem vem de uma função, não da lista direto: com a lista, o
  // pacote `cors` mandaria o Allow-Credentials em toda resposta; assim, origem
  // fora da lista (ou request sem Origin) não recebe header de CORS nenhum.
  //
  // `exposedHeaders`: sem ele o JS de outra origem não lê o `Retry-After` dos
  // 429 (o browser só expõe os headers "simples" por padrão).
  const corsOrigins = new Set(config.get('CORS_ORIGINS', { infer: true }));
  if (corsOrigins.size > 0) {
    const origin: CustomOrigin = (requestOrigin, callback) =>
      callback(
        null,
        requestOrigin !== undefined && corsOrigins.has(requestOrigin),
      );
    app.enableCors({
      origin,
      credentials: true,
      exposedHeaders: ['Retry-After'],
    });
  }

  // De quem aceitar o X-Forwarded-For para definir o req.ip, que o rate limit
  // e o log de segurança usam. Desligado por padrão: sem proxy na
  // frente, o header vem do próprio cliente e seria forjável. O valor já vem
  // validado e convertido (número de saltos como number, nunca `true`).
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  warnAboutTrustProxy(config);

  if (!swaggerEnabled) return;

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Dutrail API')
    .setDescription(
      'API do Dutrail (atividades ao ar livre): autenticação e atividades.',
    )
    .setVersion('0.1')
    // Habilita o botão "Authorize" no Swagger para colar o access token.
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    SWAGGER_PATH,
    app,
    () => SwaggerModule.createDocument(app, swaggerConfig),
    { useGlobalPrefix: true },
  );
}

/**
 * Em development/test, avisa (sem falhar e sem imprimir valores) quando a
 * configuração do Google parece o placeholder ou aponta o callback para outra
 * rota. Em produção quem cuida é a validação do boot.
 */
export function warnAboutGoogleConfig(
  config: ConfigService<EnvironmentVariables, true>,
  logger = new Logger('Config'),
): void {
  const warnings = googleConfigWarnings(
    {
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      GOOGLE_CLIENT_ID: config.get('GOOGLE_CLIENT_ID', { infer: true }),
      GOOGLE_CLIENT_SECRET: config.get('GOOGLE_CLIENT_SECRET', { infer: true }),
      GOOGLE_CALLBACK_URL: config.get('GOOGLE_CALLBACK_URL', { infer: true }),
    },
    GOOGLE_CALLBACK_PATH,
  );
  for (const warning of warnings) {
    logger.warn(warning);
  }
}

/**
 * Em produção sem TRUST_PROXY, lembra (sem falhar) que atrás de um proxy
 * reverso ou load balancer o IP visto pelo rate limit e pelo log de segurança
 * é o do proxy. Sem proxy na frente, desligado é o correto.
 */
export function warnAboutTrustProxy(
  config: ConfigService<EnvironmentVariables, true>,
  logger = new Logger('Config'),
): void {
  if (config.get('NODE_ENV', { infer: true }) !== NodeEnv.Production) return;
  if (config.get('TRUST_PROXY', { infer: true }) !== false) return;
  logger.warn(
    'TRUST_PROXY não definido: se a API estiver atrás de um proxy reverso ou load balancer, o IP visto pelo rate limit e pelo log de segurança será o do proxy',
  );
}
