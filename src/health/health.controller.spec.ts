import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('responde { status: "ok" }', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok' });
  });

  it('não recebe dependências: não tem como consultar o banco nem o storage', () => {
    expect(HealthController.length).toBe(0);
  });
});
