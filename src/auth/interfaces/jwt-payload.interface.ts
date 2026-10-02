/**
 * Claims que NÓS colocamos no access token (além de iat/exp do jsonwebtoken).
 * Sem `email` (A-21): o payload é só base64, e o token vai parar em logs de
 * proxies e ferramentas de terceiros. Quem precisar do email busca no banco.
 * Tokens emitidos antes ainda o trazem e continuam válidos: ninguém o lê.
 */
export interface AccessTokenPayload {
  /** "subject": id do usuário (claim padrão do JWT). */
  sub: string;
}

/**
 * Claims do refresh token. O `jti` (JWT ID) é um UUID aleatório: sem ele,
 * dois refresh tokens emitidos no mesmo segundo para o mesmo usuário seriam
 * byte a byte idênticos (mesmo payload + mesmo iat) e colidiriam no banco.
 */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
}
