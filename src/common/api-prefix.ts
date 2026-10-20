/**
 * Prefixo global de todas as rotas (`app.setGlobalPrefix` em app.setup).
 *
 * Quem monta caminho fora do roteamento do Nest (path dos cookies, rota do
 * callback do Google, CSP do Swagger) parte daqui.
 */
export const API_PREFIX = 'api';
