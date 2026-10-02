import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Request, RequestHandler } from 'express';
import helmet from 'helmet';
import { GOOGLE_CALLBACK_PATH } from './auth/google-callback.js';
import {
  EnvironmentVariables,
  googleConfigWarnings,
  NodeEnv,
} from './config/env.validation.js';

/** Onde o Swagger é montado: UI em /docs (e assets em /docs/*), JSON em /docs-json. */
export const SWAGGER_PATH = 'docs';

/**
 * O Swagger (UI e JSON) só existe fora de produção: em produção ele entregaria
 * o mapa completo da API para quem varre a internet (A-10). Os clientes usam
 * os contratos em docs/.
 */
export function shouldSetupSwagger(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== NodeEnv.Production;
}

/** Rotas servidas pelo Swagger que recebem a CSP própria da UI. */
export function isSwaggerPath(path: string): boolean {
  const base = `/${SWAGGER_PATH}`;
  return (
    path === base || path.startsWith(`${base}/`) || path === `${base}-json`
  );
}

/**
 * Cabeçalhos de segurança (A-06). O helmet tira o `X-Powered-By` e manda
 * nosniff, Referrer-Policy: no-referrer, COOP/CORP same-origin etc.
 *
 * - HSTS: 1 ano com subdomínios, sem preload (preload é difícil de desfazer).
 *   Se o proxy da VM também emitir HSTS, precisa ser com o mesmo valor.
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

  // A Swagger UI carrega só scripts do próprio /docs (script-src 'self' basta)
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
 * Configuração da aplicação que não cabe em módulos (cabeçalhos de segurança,
 * pipes globais, CORS, Swagger). Fica separada do main.ts para os testes e2e
 * subirem a app exatamente como em produção.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<EnvironmentVariables, true>);
  warnAboutGoogleConfig(config);
  const swaggerEnabled = shouldSetupSwagger(
    config.get('NODE_ENV', { infer: true }),
  );

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

  // Só o frontend web precisa de CORS; apps nativos (Android) não têm
  // "origin" e não passam por essa checagem.
  //
  // `credentials: true` é obrigatório para o cookie httpOnly do refresh token:
  // sem ele o browser não envia o cookie nem aceita o Set-Cookie cross-origin.
  // Exige origem explícita — com credentials, o wildcard '*' é rejeitado pelo
  // próprio browser.
  app.enableCors({
    origin: config.get('FRONTEND_URL', { infer: true }),
    credentials: true,
  });

  // De quem aceitar o X-Forwarded-For para definir o req.ip, que o rate limit
  // e o log de segurança usam (A-03). Desligado por padrão: sem proxy na
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
  SwaggerModule.setup(SWAGGER_PATH, app, () =>
    SwaggerModule.createDocument(app, swaggerConfig),
  );
}

/**
 * Em development/test, avisa (sem falhar e sem imprimir valores) quando a
 * configuração do Google parece o placeholder ou aponta o callback para outra
 * rota. Em produção quem cuida é a validação do boot (A-05).
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
    'TRUST_PROXY não definido: se a API estiver atrás de um proxy reverso ou load balancer, o IP visto pelo rate limit e pelo log de segurança será o do proxy (ver "Rate limit e proxy" no README)',
  );
}
