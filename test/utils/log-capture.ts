/**
 * Captura TODA saída do Logger do Nest (log, warn, error...), não só a do
 * SecurityLog: os testes de vazamento varrem tudo.
 *
 * O createAppWithEnv reimporta os módulos (vi.resetModules), então o Logger
 * precisa vir da MESMA instância que a app usa: chame depois de a app subir.
 */

export interface CapturedLine {
  level: string;
  /** Mensagem + parâmetros extras (stack, contexto), serializados. */
  text: string;
  message: unknown;
}

export interface SecurityLine {
  level: string;
  event: string;
  timestamp: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  clientType?: string;
  emailMasked?: string;
  reason?: string;
}

const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

export async function captureNestLogs() {
  const { Logger } = await import('@nestjs/common');
  const lines: CapturedLine[] = [];
  const spies = LEVELS.map((level) =>
    vi
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown, ...rest: unknown[]) => {
        lines.push({
          level,
          message,
          text: JSON.stringify([message, ...rest]),
        });
      }),
  );

  return {
    lines,
    clear: () => {
      lines.length = 0;
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
    /** Só as linhas do SecurityLog, parseadas. */
    events: (): SecurityLine[] =>
      lines.flatMap(({ level, message }) => {
        if (typeof message !== 'string' || !message.startsWith('{')) return [];
        const parsed = JSON.parse(message) as Partial<SecurityLine>;
        return parsed.event ? [{ level, ...parsed } as SecurityLine] : [];
      }),
  };
}

export type LogCapture = Awaited<ReturnType<typeof captureNestLogs>>;
