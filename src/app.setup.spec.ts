import { isSwaggerPath, shouldSetupSwagger } from './app.setup.js';
import { NodeEnv } from './config/env.validation.js';

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
