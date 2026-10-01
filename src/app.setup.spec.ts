import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isSwaggerPath,
  shouldSetupSwagger,
  warnAboutGoogleConfig,
} from './app.setup.js';
import { EnvironmentVariables, NodeEnv } from './config/env.validation.js';

describe('shouldSetupSwagger', () => {
  it('não registra o Swagger em produção', () => {
    expect(shouldSetupSwagger(NodeEnv.Production)).toBe(false);
  });

  it.each([NodeEnv.Development, NodeEnv.Test])(
    'registra o Swagger em %s',
    (nodeEnv) => {
      expect(shouldSetupSwagger(nodeEnv)).toBe(true);
    },
  );
});

describe('isSwaggerPath', () => {
  it.each([
    '/docs',
    '/docs/',
    '/docs/index.html',
    '/docs/swagger-ui-bundle.js',
    '/docs-json',
  ])('%s recebe a CSP da Swagger UI', (path) => {
    expect(isSwaggerPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/auth/login',
    '/docsx',
    '/docs-yaml',
    '/api/docs',
    '/documents',
  ])('%s fica com a CSP da API', (path) => {
    expect(isSwaggerPath(path)).toBe(false);
  });
});

describe('warnAboutGoogleConfig', () => {
  function configWith(values: Partial<EnvironmentVariables>) {
    return {
      get: (name: keyof EnvironmentVariables) => values[name],
    } as unknown as ConfigService<EnvironmentVariables, true>;
  }
  const suspicious = {
    GOOGLE_CLIENT_ID: 'xxx.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'troque-isto',
    GOOGLE_CALLBACK_URL: 'http://localhost:3000/callback',
  };

  it.each([NodeEnv.Development, NodeEnv.Test])(
    'em %s, um warn por problema, sem os valores e sem lançar',
    (nodeEnv) => {
      const warn = vi.fn();
      expect(() =>
        warnAboutGoogleConfig(
          configWith({ NODE_ENV: nodeEnv, ...suspicious }),
          { warn } as unknown as Logger,
        ),
      ).not.toThrow();

      const calls = warn.mock.calls.flat().join('\n');
      expect(warn).toHaveBeenCalledTimes(3);
      for (const value of Object.values(suspicious)) {
        expect(calls).not.toContain(value);
      }
    },
  );

  it('em produção não emite nada', () => {
    const warn = vi.fn();
    warnAboutGoogleConfig(
      configWith({ NODE_ENV: NodeEnv.Production, ...suspicious }),
      { warn } as unknown as Logger,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
