import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import type { ClientType } from '../common/decorators/client-type.decorator.js';
import { EnvironmentVariables, NodeEnv } from '../config/env.validation.js';

/** Nome do cookie que carrega o refresh token no fluxo web. */
export const REFRESH_COOKIE_NAME = 'refreshToken';

/**
 * Escopo do cookie: o browser só o envia para /auth/*, então ele não acompanha
 * as chamadas normais da API (menos superfície para vazamento em logs/proxies).
 */
const REFRESH_COOKIE_PATH = '/auth';

/** Igual ao JWT_REFRESH_TTL padrão (7 dias). */
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Única peça que sabe **por onde** o refresh token entra e sai. A lógica de
 * negócio (rotação, detecção de reuso, revogação) continua inteira no
 * TokenService e não tem ideia de cookie ou header.
 *
 * - `web`   -> cookie httpOnly (inacessível a JavaScript, imune a XSS)
 * - `mobile`-> corpo JSON (app nativo não tem cookie jar do browser)
 *
 * Canal errado para o tipo declarado é 400, nunca um fallback silencioso: um
 * cliente que manda o token no lugar errado está com bug, e aceitar os dois
 * canais anularia a proteção do httpOnly.
 */
@Injectable()
export class RefreshTokenTransport {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * Opções do cookie. `clearCookie` precisa das MESMAS opções do `cookie()`
   * (o browser casa nome + path + domínio), por isso ficam num lugar só.
   *
   * Atenção ao deploy: `sameSite: 'lax'` exige que API e frontend estejam no
   * mesmo site registrável (dutrail.com e api.dutrail.com servem; domínios
   * diferentes, não). Ver "CSRF" no README antes de mudar para 'none'.
   */
  cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // Em produção o cookie só trafega por HTTPS. Em dev/test fica false,
      // senão o browser (e o supertest) descartam o cookie em http://.
      secure:
        this.config.get('NODE_ENV', { infer: true }) === NodeEnv.Production,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
    };
  }

  /**
   * Entrega o refresh token ao cliente e devolve o que vai no corpo da
   * resposta: o token para mobile, `undefined` para web (onde já foi no cookie).
   */
  deliver(
    clientType: ClientType,
    res: Response,
    refreshToken: string,
  ): string | undefined {
    if (clientType === 'mobile') {
      return refreshToken;
    }

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      ...this.cookieOptions(),
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    });
    return undefined;
  }

  /** Remove o cookie no logout web. No-op para mobile. */
  clear(clientType: ClientType, res: Response): void {
    if (clientType === 'web') {
      res.clearCookie(REFRESH_COOKIE_NAME, this.cookieOptions());
    }
  }

  /**
   * Lê o refresh token do canal correspondente ao tipo declarado.
   *
   * Devolve `undefined` quando o canal certo está vazio — quem chama decide se
   * isso é 401 (refresh precisa da credencial) ou 204 (logout é idempotente).
   * Token no canal errado, por outro lado, é sempre 400.
   */
  read(
    clientType: ClientType,
    req: Request,
    bodyToken?: string,
  ): string | undefined {
    const cookieToken = this.cookieToken(req);

    if (clientType === 'web') {
      if (bodyToken !== undefined) {
        throw new BadRequestException(
          'refreshToken must not be sent in the request body when X-Client-Type is web; ' +
            'it is read from the httpOnly cookie',
        );
      }
      return cookieToken;
    }

    if (cookieToken !== undefined) {
      throw new BadRequestException(
        `${REFRESH_COOKIE_NAME} cookie must not be sent when X-Client-Type is mobile; ` +
          'send refreshToken in the request body',
      );
    }
    return bodyToken;
  }

  private cookieToken(req: Request): string | undefined {
    // `req.cookies` só existe se o cookie-parser estiver instalado (app.setup).
    const value = (req.cookies as Record<string, unknown> | undefined)?.[
      REFRESH_COOKIE_NAME
    ];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
