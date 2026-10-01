import type { Request } from 'express';
import {
  CLIENT_TYPE_HEADER,
  parseClientType,
  type ClientType,
} from '../common/decorators/client-type.decorator.js';

/**
 * Quem fez a request, do jeito que o log de segurança precisa. Montado no
 * controller (que tem o `req`) e passado como parâmetro aos services.
 *
 * Parâmetro explícito em vez de provider request-scoped ou AsyncLocalStorage:
 * o escopo de request se propaga para toda a cadeia de injeção (AuthService,
 * TokenService, strategies...) e recria tudo a cada request; o ALS esconde a
 * dependência. Assim fica visível na assinatura quem depende de contexto, e o
 * teste unitário só passa um objeto.
 */
export interface SecurityContext {
  /** `req.ip`. Sem `trust proxy` configurado (A-03), é o IP do proxy. */
  ip?: string;
  /** Cru; o SecurityLogService trunca antes de registrar. */
  userAgent?: string;
  clientType?: ClientType;
}

export function securityContextFrom(
  req: Request,
  clientType?: ClientType,
): SecurityContext {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip,
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
    clientType,
  };
}

/**
 * X-Client-Type para quem não passou pelo `@ClientType()` (o filtro global):
 * só um valor válido conta, e nada é lançado.
 */
export function declaredClientType(req: Request): ClientType | undefined {
  try {
    return parseClientType(req.headers[CLIENT_TYPE_HEADER]);
  } catch {
    return undefined;
  }
}
