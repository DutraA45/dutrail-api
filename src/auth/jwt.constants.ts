/**
 * Claims fixas dos JWTs (A-14). O `iss` vem do JWT_ISSUER; o `aud` é
 * constante e diferente por tipo de token, de modo que um não é aceito no
 * lugar do outro mesmo que algum dia compartilhem segredo.
 */
export const JWT_ALGORITHM = 'HS256';
export const ACCESS_TOKEN_AUDIENCE = 'dutrail-access';
export const REFRESH_TOKEN_AUDIENCE = 'dutrail-refresh';

/**
 * Única mensagem do 401 para refresh token recebido e recusado (A-18): JWT
 * inválido, expirado, não encontrado ou reuso. O motivo específico vai só
 * para o log de segurança.
 */
export const INVALID_REFRESH_TOKEN_MESSAGE = 'Invalid refresh token';
