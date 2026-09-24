import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { EnvironmentVariables } from './config/env.validation.js';

/**
 * Configuração da aplicação que não cabe em módulos (pipes globais, CORS,
 * Swagger). Fica separada do main.ts para os testes e2e subirem a app
 * exatamente como em produção.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<EnvironmentVariables, true>);

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

  // Só o frontend web precisa de CORS; apps nativos (React Native) não têm
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

  // Atrás de um proxy/load balancer (Render, Fly, Railway...), descomente para
  // o rate limit enxergar o IP real do cliente em vez do IP do proxy:
  // app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Dutrail API')
    .setDescription(
      'API do Dutrail (atividades ao ar livre): autenticação e atividades.',
    )
    .setVersion('0.1')
    // Habilita o botão "Authorize" no Swagger para colar o access token.
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, swaggerConfig),
  );
}
