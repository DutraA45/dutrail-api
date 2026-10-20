import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvironmentVariables } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get(ConfigService<EnvironmentVariables, true>);
  // HOST padrão 127.0.0.1: só conexões locais. HOST=0.0.0.0 no dev expõe na
  // rede local (teste do app no celular).
  await app.listen(
    config.get('PORT', { infer: true }),
    config.get('HOST', { infer: true }),
  );
}

await bootstrap();
