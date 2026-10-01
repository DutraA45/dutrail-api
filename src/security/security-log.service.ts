import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from '../config/env.validation.js';
import type { SecurityContext } from './security-context.js';

export const SECURITY_EVENTS = [
  'signup',
  'login_success',
  'login_failed',
  'refresh_success',
  'refresh_invalid',
  'refresh_reuse_detected',
  'logout',
  'google_link',
  'google_exchange_success',
  'google_exchange_failed',
  'rate_limited',
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

/**
 * Motivos possíveis, como códigos fixos. Ser um tipo (e não `string`) impede
 * que texto livre — mensagem de exceção, valor vindo do cliente — chegue ao log.
 */
export type SecurityReason =
  // login_failed
  | 'unknown_email'
  | 'no_password'
  | 'wrong_password'
  // refresh_invalid / logout
  | 'missing_token'
  | 'invalid_jwt'
  | 'expired'
  | 'not_found'
  | 'concurrent_rotation'
  | 'no_token'
  // google_link
  | 'verified_account'
  | 'unverified_takeover'
  // google_exchange_failed: troca do código (POST /auth/google/exchange)
  | 'used'
  | 'concurrent_use'
  // google_exchange_failed: callback do Google (A-13), um por código de
  // ?error= do redirect; `callback_error` é o `oauth_failed`
  | 'state_mismatch'
  | 'access_denied'
  | 'email_not_verified'
  | 'callback_error';

export interface SecurityEventDetails {
  userId?: string;
  /** Email em claro: o serviço só registra a versão mascarada. */
  email?: string;
  reason?: SecurityReason;
}

/** Uma linha do log. Campos `undefined` somem no JSON. */
export interface SecurityLogEntry {
  event: SecurityEvent;
  timestamp: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  clientType?: string;
  emailMasked?: string;
  reason?: SecurityReason;
}

export const SECURITY_LOG_CONTEXT = 'SecurityLog';
export const USER_AGENT_MAX_LENGTH = 200;

/**
 * `ana@example.com` -> `a***@e***.com`. Sobra o suficiente para correlacionar
 * tentativas contra o mesmo alvo, mas não para recuperar o endereço. Sem hash
 * de propósito: o hash de um email é revertido por dicionário.
 */
export function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return '***';

  const first = (s: string) => Array.from(s)[0];
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${first(local)}***@${first(domain)}***${tld}`;
}

/**
 * Log estruturado de eventos de segurança (A-07): uma linha JSON por evento,
 * pelo Logger do Nest, com contexto `SecurityLog`.
 *
 * Nunca recebe senha, token, código de troca, hash nem URL: a assinatura só
 * aceita o contexto da request, o userId, o email (mascarado aqui) e um motivo
 * fixo. `warn` para falhas e suspeitas, `log` para sucessos.
 */
@Injectable()
export class SecurityLogService {
  private readonly logger = new Logger(SECURITY_LOG_CONTEXT);
  private readonly enabled: boolean;

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    this.enabled = config.get('SECURITY_LOG_ENABLED', { infer: true });
  }

  log(
    event: SecurityEvent,
    ctx: SecurityContext,
    details: SecurityEventDetails = {},
  ): void {
    if (!this.enabled) return;
    this.logger.log(JSON.stringify(this.entry(event, ctx, details)));
  }

  warn(
    event: SecurityEvent,
    ctx: SecurityContext,
    details: SecurityEventDetails = {},
  ): void {
    if (!this.enabled) return;
    this.logger.warn(JSON.stringify(this.entry(event, ctx, details)));
  }

  private entry(
    event: SecurityEvent,
    ctx: SecurityContext,
    details: SecurityEventDetails,
  ): SecurityLogEntry {
    return {
      event,
      timestamp: new Date().toISOString(),
      userId: details.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, USER_AGENT_MAX_LENGTH),
      clientType: ctx.clientType,
      emailMasked:
        details.email === undefined ? undefined : maskEmail(details.email),
      reason: details.reason,
    };
  }
}
