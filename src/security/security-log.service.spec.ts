import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { SecurityContext } from './security-context.js';
import {
  maskEmail,
  SecurityLogService,
  USER_AGENT_MAX_LENGTH,
} from './security-log.service.js';

function createService(enabled = true): SecurityLogService {
  const config = {
    get: (key: string) =>
      key === 'SECURITY_LOG_ENABLED' ? enabled : undefined,
  } as unknown as ConfigService<EnvironmentVariables, true>;
  return new SecurityLogService(config);
}

const ctx: SecurityContext = {
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  clientType: 'web',
};

describe('SecurityLogService', () => {
  const logSpy = vi
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  const warnSpy = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);

  beforeEach(() => {
    logSpy.mockClear();
    warnSpy.mockClear();
  });
  afterAll(() => vi.restoreAllMocks());

  /** A linha emitida pela última chamada ao spy, já parseada. */
  function lastLine(spy: typeof logSpy): Record<string, unknown> {
    const message = spy.mock.calls.at(-1)?.[0];
    expect(typeof message).toBe('string');
    // Uma linha só: nada de JSON indentado.
    expect(message).not.toContain('\n');
    return JSON.parse(message as string) as Record<string, unknown>;
  }

  it('emite uma linha JSON com todos os campos, via log() para sucessos', () => {
    createService().log('login_success', ctx, { userId: 'user-1' });

    expect(warnSpy).not.toHaveBeenCalled();
    const line = lastLine(logSpy);
    expect(line).toEqual({
      event: 'login_success',
      timestamp: expect.any(String),
      userId: 'user-1',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      clientType: 'web',
    });
    expect(new Date(line.timestamp as string).toISOString()).toBe(
      line.timestamp,
    );
  });

  it('usa warn() para falhas, com reason e o email mascarado', () => {
    createService().warn('login_failed', ctx, {
      userId: 'user-1',
      email: 'ana@example.com',
      reason: 'wrong_password',
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(lastLine(warnSpy)).toMatchObject({
      event: 'login_failed',
      userId: 'user-1',
      emailMasked: 'a***@e***.com',
      reason: 'wrong_password',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('ana@example.com');
  });

  it('refresh_grace_used e refresh_reuse_detected: warn com userId e familyId, nada além', () => {
    const familyId = '6f1c2a8e-3b4d-4e5f-9a7b-1c2d3e4f5a6b';
    const service = createService();
    service.warn('refresh_grace_used', ctx, { userId: 'user-1', familyId });
    service.warn('refresh_reuse_detected', ctx, { userId: 'user-1', familyId });

    expect(logSpy).not.toHaveBeenCalled();
    const [grace, reuse] = warnSpy.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
    for (const [line, event] of [
      [grace, 'refresh_grace_used'],
      [reuse, 'refresh_reuse_detected'],
    ] as const) {
      expect(line).toEqual({
        event,
        timestamp: expect.any(String),
        userId: 'user-1',
        familyId,
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        clientType: 'web',
      });
    }
  });

  it('logout_all: log com userId e a contagem de sessões apagadas', () => {
    createService().log('logout_all', ctx, {
      userId: 'user-1',
      sessionsRemoved: 3,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(lastLine(logSpy)).toEqual({
      event: 'logout_all',
      timestamp: expect.any(String),
      userId: 'user-1',
      sessionsRemoved: 3,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      clientType: 'web',
    });
  });

  it('omite os campos ausentes (sem userId, client type ou reason)', () => {
    createService().warn('rate_limited', { ip: '10.0.0.1' });

    const line = lastLine(warnSpy);
    expect(Object.keys(line).sort()).toEqual(['event', 'ip', 'timestamp']);
  });

  it(`trunca o user-agent em ${USER_AGENT_MAX_LENGTH} caracteres`, () => {
    const long = 'A'.repeat(150) + 'B'.repeat(150);
    createService().log('signup', { ...ctx, userAgent: long });

    const line = lastLine(logSpy);
    expect(line.userAgent).toBe(long.slice(0, 200));
    expect((line.userAgent as string).length).toBe(200);
  });

  it('o JSON escapa quebras de linha (sem injeção de linhas falsas no log)', () => {
    createService().log('signup', {
      ...ctx,
      userAgent: 'x\n{"event":"login_success"}',
    });

    const message = logSpy.mock.calls[0][0] as string;
    expect(message).not.toContain('\n');
    expect(JSON.parse(message).event).toBe('signup');
  });

  it('não emite nada com SECURITY_LOG_ENABLED=false', () => {
    const service = createService(false);
    service.log('signup', ctx, { userId: 'user-1' });
    service.warn('refresh_reuse_detected', ctx, { userId: 'user-1' });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('maskEmail', () => {
  it.each([
    ['ana@example.com', 'a***@e***.com'],
    ['Ana.Silva@Dutrail.com.br', 'a***@d***.br'],
    ['x@y.io', 'x***@y***.io'],
    ['joao@localhost', 'j***@l***'],
  ])('%s -> %s', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it.each(['', 'sem-arroba', '@example.com', 'ana@'])(
    'valor que não é email vira *** (%j)',
    (value) => {
      expect(maskEmail(value)).toBe('***');
    },
  );

  it('nunca contém o local-part nem o domínio completos', () => {
    const masked = maskEmail('mariana@empresa.com');
    expect(masked).not.toContain('mariana');
    expect(masked).not.toContain('empresa');
  });
});
