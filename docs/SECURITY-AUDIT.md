# Auditoria de segurança — autenticação do dutrail-api

| Campo       | Valor                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data        | 2026-09-30                                                                                                                                         |
| Commit      | `9824177` (branch `main`, árvore limpa)                                                                                                            |
| Tipo        | Revisão estática, somente leitura (código, schema, migrations, contratos, `node_modules` das libs de auth) + `npm audit`                            |
| Referências | OWASP ASVS 4.0.3 (L1/L2: V2, V3, V4, V7, V8, V9, V13), RFC 9700 (OAuth 2.0 Security BCP), RFC 8252 (OAuth para apps nativos)                       |
| Fora        | Frontend Angular, app Android, infraestrutura de produção (ver [Não verificado](#não-verificado))                                                   |

Nenhum valor de segredo aparece neste documento. As variáveis de ambiente
foram analisadas só por nome, tamanho, classes de caracteres e presença de
palavras de placeholder. Os valores não foram impressos em nenhum momento.

---

## Resumo executivo

A base é sólida: senhas com Argon2id (parâmetros OWASP), refresh token
rotativo com compare-and-set atômico e só o hash no banco, segredos de access
e refresh distintos e validados no boot, algoritmo do access token fixado em
HS256, guard JWT global com opt-out explícito, IDOR tratado em `/activities`,
e cookie `HttpOnly`/`SameSite=Lax`/`Path=/auth`. **Há um achado Alto:** a
vinculação automática Google → conta local não verificada permite _account
pre-hijacking_ (A-01). Entre os seis Médios, estes pedem correção antes de
produção: o login com Google sem `state`/PKCE, o rate limit só por IP sem
`trust proxy`, a detecção de reuso que derruba todas as sessões de todos os
dispositivos (inclusive quando uma resposta se perde na rede do celular),
a validação de segredos que aceita os placeholders do `.env.example`, a
ausência de cabeçalhos de segurança (Helmet/HSTS) e a falta de log de eventos
de segurança. Total: **1 Alta, 6 Médias, 8 Baixas, 6 Informativas.**

---

## Achados

Esforço: **P** = horas, **M** = 1–3 dias, **G** = mais que isso.

Status: **Corrigido** (confirmado no código; riscos residuais em
[Notas de correção](#notas-de-correção)), **Risco aceito** (não será
corrigido, decisão registrada) ou **Pendente** (ainda não tratado).

| ID   | Sev.        | Item | Arquivo:linha                                                                                                                                                  | Descrição                                                                                                                                                                                                                                                                                                                  | Risco concreto                                                                                                                                                                                                                                                                                                        | Correção recomendada                                                                                                                                                                                                                                                                                         | Esf. | Status |
| ---- | ----------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------ |
| A-01 | **Alta**    | 8    | `src/auth/auth.service.ts:103-109`, `src/users/users.service.ts:52-66`, `src/auth/auth.service.ts:41-58`                                                        | **Account pre-hijacking.** O signup não verifica o email (qualquer um cadastra qualquer email). Quando o dono real entra depois com Google (email verificado), `linkGoogleAccount` vincula a conta e marca `emailVerified: true`, **sem descartar o `passwordHash` nem revogar sessões existentes**. O contrato confirma: "a senha antiga continua valendo" (`docs/API-CONTRACT.md` §Login com Google). | Atacante cadastra `vitima@gmail.com` com senha própria e espera. A vítima entra com Google, "herda" a conta, importa atividades (GPS, FC, calorias). O atacante continua logando com a senha dele e lê tudo, indefinidamente. Variante: a vítima que nunca usar Google fica impedida de se cadastrar por email (409) e não há reset de senha. | Na vinculação, se `byEmail.emailVerified === false`: numa única `$transaction`, zerar `passwordHash`, revogar todos os `RefreshToken`/`OAuthExchangeCode` do usuário e só então vincular. Alternativa mais restritiva: recusar a vinculação automática e exigir login por senha para vincular. Adicionar e2e cobrindo o cenário. | P    | **Corrigido.** Ver [nota](#a-01). |
| A-02 | **Média**   | 8    | `src/auth/strategies/google.strategy.ts:25-30`; `node_modules/passport-oauth2/lib/strategy.js:109-113`                                                          | **Redirect do Google sem `state` e sem PKCE.** Sem `state`/`pkce` nas opções, o passport-oauth2 usa o `NullStore`: o callback aceita qualquer `code` sem vínculo com o browser que iniciou o fluxo. Contraria RFC 9700 §2.1 e §4.7 (proteção CSRF obrigatória; PKCE recomendado também para cliente confidencial). | **Login CSRF**: o atacante inicia o fluxo com a própria conta Google, para antes do callback e faz a vítima abrir essa URL. A vítima fica logada na conta do atacante e as atividades que importar (com trilhas GPS) vão para ele. Também permite injeção de `code` interceptado.                                                  | Habilitar `state: true` e `pkce: true` com um store próprio (sessão está desligada): cookie curto, assinado, `HttpOnly`, `SameSite=Lax`, `Path=/auth/google`, guardando nonce e `code_verifier`; ou uma tabela com TTL. Validar no callback e apagar o cookie.                                                           | M    | **Corrigido.** Ver [nota](#a-02). |
| A-03 | **Média**   | 3    | `src/app.setup.ts:42-44`, `src/auth/auth.controller.ts:59`, `src/app.module.ts:22-34`; `node_modules/@nestjs/throttler/dist/throttler.guard.js:144-145`          | **Rate limit só por IP, sem `trust proxy`, sem limite por conta nem atraso progressivo.** O tracker padrão é `req.ip`; `trust proxy` está comentado. Storage em memória (por processo, zera no restart). `/auth/refresh`, `/auth/logout` e `/auth/google/exchange` ficam só no limite global (100/min). Não há bloqueio nem backoff por email (ASVS 2.2.1). | (a) Atrás de proxy reverso/LB na VM Oracle, todos os clientes compartilham o IP do proxy: **10 logins/min para o mundo inteiro**, e qualquer um derruba o login de todos. (b) Com IPs distribuídos (botnet, IPv6), o credential stuffing contra uma conta fica ilimitado (N IPs × 10/min). (c) Se alguém "consertar" com `trust proxy: true`, o `X-Forwarded-For` passa a ser forjável e o limite some. | Definir `trust proxy` com o número exato de saltos ou o IP do proxy (nunca `true`). Adicionar um segundo throttler com chave = email normalizado para login (ex.: 5 falhas/15 min, com backoff exponencial), sem revelar se a conta existe. Limite próprio em `/auth/refresh` e `/auth/google/exchange`. Storage Redis se houver mais de uma instância. | M    | **Corrigido.** Ver [nota](#a-03). |
| A-04 | **Média**   | 5    | `src/auth/token.service.ts:145-151`, `:120-125`, `:92-100`; `prisma/schema.prisma:36-48`; `docs/AUTH-CONTRACT-MOBILE.md:276-280`                                 | **Detecção de reuso sem família de tokens: qualquer reuso revoga todas as sessões de todos os dispositivos, sem janela de tolerância.** Não há `familyId`/`replacedBy`; `revokeAllForUser` pega todo `userId`. Ver [análise do item 5](#item-5--cenário-mobile-resposta-do-refresh-perdida). | (a) Rede móvel perde a resposta do refresh e o app (seguindo o contrato, que manda **não** limpar a sessão em erro de rede) reapresenta o token antigo: logout em web e em todos os celulares. (b) Duas abas web renovando juntas podem disparar o mesmo efeito. (c) DoS dirigido: quem tiver **qualquer** refresh token antigo da vítima (ainda dentro do `exp`) derruba todas as sessões dela, repetidamente, por até 7 dias. | Adicionar `familyId` (herdado na rotação) e revogar só a família no reuso. Adicionar janela de tolerância (30–60 s, uso único) para o token recém-rotacionado cujo sucessor ainda não foi usado. Envolver CAS + emissão numa `$transaction`. Detalhes na análise abaixo.                                                              | M    | **Corrigido.** Ver [nota](#a-04). |
| A-05 | **Média**   | 4, 13 | `src/config/env.validation.ts:28-29`, `:42-49`; `.env.example` (`JWT_SECRET`, `JWT_REFRESH_SECRET`)                                                            | **Validação de segredos aceita placeholders conhecidos e `NODE_ENV` falha aberto.** A regra é só `MinLength(32)` e segredos diferentes entre si. Os placeholders do `.env.example` (frases "troque-…" com mais de 50 chars) passam. `NODE_ENV` tem default `development`. No `.env` local, os dois segredos JWT são frases legíveis de dev (não aleatórias): aceitável só em dev. | Deploy com o `.env.example` copiado: o segredo HS256 é público no repositório e qualquer um forja access tokens com `sub` arbitrário (**takeover de qualquer conta**). `NODE_ENV` esquecido em produção: cookie sem `Secure` (A-11) e Swagger exposto (A-10).                                                                        | No boot, recusar segredos que contenham trechos do `.env.example` (ex.: "troque") ou com entropia baixa; exigir ≥ 43 chars base64url (256 bits). Tornar `NODE_ENV` obrigatório, sem default. Documentar a geração (`randomBytes(48)`, já citado no `.env.example`).                                                                | P    | **Corrigido.** Ver [nota](#a-05). |
| A-06 | **Média**   | 11   | `src/app.setup.ts:12-57` (sem Helmet); `package.json:29-51` (`helmet` ausente); `node_modules/express/lib/application.js:94`                                     | **Sem cabeçalhos de segurança.** Não há Helmet: sem `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`/`frame-ancestors` (a Swagger UI é HTML) nem `Referrer-Policy`. `X-Powered-By: Express` segue ativo (padrão do Express 5). ASVS 14.4.x, 9.1.1.                                          | Sem HSTS, o primeiro acesso por `http://` fica exposto a SSL stripping (vale para o access token no corpo, embora o cookie `Secure` resista). A Swagger UI pode ser emoldurada (clickjacking do "Try it out" com Bearer colado). Fingerprinting do stack.                                                            | `app.use(helmet())` com HSTS `max-age=31536000; includeSubDomains`, CSP compatível com a Swagger UI (ou Swagger desligado em produção) e `frame-ancestors 'none'`. O Helmet já remove o `X-Powered-By`. Se o HSTS ficar no proxy, documentar.                                                                              | P    | **Corrigido.** helmet é o primeiro middleware (`src/app.setup.ts`): HSTS `max-age=31536000; includeSubDomains` emitido pela app, CSP padrão do helmet com `frame-ancestors 'none'`, `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`, sem `X-Powered-By`, inclusive em 401/404. Só `/docs`, `/docs/*` e `/docs-json` recebem a CSP sem `upgrade-insecure-requests`. Coberto por `test/security-headers.e2e-spec.ts`. |
| A-07 | **Média**   | 12   | `src/auth/token.service.ts:145-151`; `src/auth/auth.service.ts:67-69`, `:145-157`; loggers existentes só em `src/common/filters/all-exceptions.filter.ts:25` e `src/activities/activities.service.ts:31` | **Nenhum log de eventos de segurança.** Login falho, reuso de refresh token (revoga tudo em silêncio), código de troca inválido, vinculação de conta Google, logout e 429 não são registrados. ASVS 7.1.3, 7.2.1, 7.2.2 (L2).                                                                                            | Um roubo de token (reuso) ou um credential stuffing em curso ficam invisíveis. Sem trilha forense para responder a incidente ou a reclamação de "fui deslogado".                                                                                                                                                  | Logger estruturado (JSON) com `event`, `userId` quando houver, IP real, user-agent e timestamp. Nunca senha nem token, e email mascarado ou em hash. Alerta para `refresh_reuse_detected` e para picos de `login_failed`.                                                                                                      | P    | **Corrigido.** Ver [nota](#a-07). |
| A-08 | Baixa       | 9    | `src/auth/token.service.ts:120-125`; `src/auth/auth.controller.ts:182-217`                                                                                      | **Não há como o usuário revogar todas as sessões.** `revokeAllForUser` existe, mas só a detecção de reuso o chama. Não há "sair de todos os dispositivos" nem troca de senha que invalide sessões. ASVS 3.3.3, 3.3.4 (L2).                                                                                               | Celular perdido ou roubado: o usuário não consegue cortar o refresh token do aparelho (válido e renovável indefinidamente, pela janela deslizante).                                                                                                                                                                | `POST /auth/logout-all` (Bearer) chamando `revokeAllForUser` e devolvendo 204. No futuro, chamar o mesmo na troca e no reset de senha.                                                                                                                                                                                       | P    | Pendente |
| A-09 | Baixa       | 1    | `src/auth/dto/signup.dto.ts:26-29`; `src/auth/password.service.ts:23-25`, `:28-30`                                                                              | **Política de senha abaixo do ASVS e sem normalização Unicode.** Mínimo de 8 (ASVS 2.1.1 pede 12). Sem checagem contra senhas vazadas (2.1.7). Sem `normalize('NFKC')` antes do hash, então "é" pré-composto e "e + ◌́" geram hashes diferentes.                                                                            | Senhas fracas ou vazadas aceitas. Usuário que cria a senha num teclado e digita em outro (Android × macOS) pode não conseguir logar.                                                                                                                                                                                | Mínimo 12, ou 8 com checagem na lista de vazadas (HIBP por k-anonymity, que exige rede). Aplicar `normalize('NFKC')` em `hash` e `verify`; para os hashes existentes, verificar primeiro normalizado e, se falhar, o valor bruto, fazendo rehash no sucesso. O teto de 128 está conforme (ASVS 2.1.2).                           | P    | Pendente |
| A-10 | Baixa       | 11   | `src/app.setup.ts:46-57`                                                                                                                                       | **Swagger (`/docs`, `/docs-json`) exposto incondicionalmente, inclusive em produção.**                                                                                                                                                                                                                                  | Mapa completo da superfície da API para quem varre a internet, e uma página HTML sem CSP (ver A-06). O risco é baixo porque o contrato já é compartilhado com os clientes.                                                                                                                                         | Registrar só quando `NODE_ENV !== production`, ou proteger com basic auth / allowlist de IP no proxy.                                                                                                                                                                                                  | P    | **Corrigido.** O Swagger só é registrado com `NODE_ENV !== 'production'` (`shouldSetupSwagger` em `src/app.setup.ts`); em produção `/docs`, `/docs-json` e `/docs-yaml` respondem 404. Coberto por `test/swagger-by-env.e2e-spec.ts`. |
| A-11 | Baixa       | 6    | `src/auth/refresh-token-transport.service.ts:17`, `:50-51`, `:72`                                                                                               | **Cookie: `Max-Age` fixo e `Secure` condicionado.** `Max-Age` é 7 dias fixos, independente de `JWT_REFRESH_TTL` (divergência documentada em `docs/API-CONTRACT.md:91-94`). `Secure` só entra se `NODE_ENV === 'production'`, então falha aberto (ver A-05). Sem prefixo `__Secure-`.                                                 | TTL do refresh maior que 7 dias: o browser descarta o cookie antes da sessão expirar no servidor. `NODE_ENV` errado: o refresh token trafega em HTTP puro.                                                                                                                                                       | Calcular `maxAge` a partir do `exp` do token emitido. `secure: true` por padrão, desligado só com flag explícita de dev. Renomear para `__Secure-refreshToken` (o `__Host-` exigiria `Path=/`).                                                                                                        | P    | **Corrigido.** Ver [nota](#a-11). |
| A-12 | Baixa       | 5    | `prisma/schema.prisma:36-61`; `README.md:324`                                                                                                                  | **Sem limpeza de `RefreshToken` e `OAuthExchangeCode` expirados** (o README reconhece). Tokens revogados ficam para sempre.                                                                                                                                                                                             | As tabelas crescem sem limite e guardam metadados de sessão (userId, horários) além do necessário (ASVS 8.3.x, minimização).                                                                                                                                                                                      | Job diário: `deleteMany where expiresAt < now()`. Só apagar depois do `exp`, porque até lá o registro revogado ainda serve para detectar reuso.                                                                                                                                                                                  | P    | Pendente |
| A-13 | Baixa       | 8    | `node_modules/passport-oauth2/lib/strategy.js:134-139`; `node_modules/@nestjs/passport/dist/auth.guard.js:55-57`; `src/auth/auth.controller.ts:247-260`           | **Cancelamento do consentimento e erros do Google terminam no domínio da API.** `error=access_denied` vira `fail()` e depois 401 em JSON, na aba do usuário. Outros `error=` e `code` inválido viram 500 (logado com stack). O mesmo vale para "email não verificado" (`auth.service.ts:99-101`). Documentado em `docs/API-CONTRACT.md:347`. | Usuário preso numa página JSON. Qualquer um pode chamar `/auth/google/callback?code=lixo` e gerar 500 + stack no log (poluição de log; o limite global de 100/min atenua).                                                                                                                                         | Sobrescrever `GoogleAuthGuard.handleRequest` para redirecionar a `${FRONTEND_URL}/auth/callback?error=<código fixo>` (sem descrição vinda do Google). Tratar `TokenError` como 4xx sem stack.                                                                                                                     | P    | **Corrigido.** Ver [nota](#a-13). |
| A-14 | Baixa       | 4    | `src/auth/token.service.ts:51-67`, `:161-168`; `src/auth/strategies/jwt.strategy.ts:22-28`; `src/config/env.validation.ts:51-57`; `node_modules/jsonwebtoken/verify.js:132-134` | **JWT sem `iss`/`aud`/`typ`; verificação do refresh não fixa o algoritmo; TTLs sem limite.** O access token fixa HS256, mas o refresh aceita HS256/384/512 (padrão do jsonwebtoken para segredo simétrico; `none` continua rejeitado). `JWT_*_TTL` só são validados como string. ASVS 3.5.3.                                                         | Baixo hoje, porque os segredos distintos já impedem trocar access por refresh (e há e2e disso em `test/auth.e2e-spec.ts:457`). Vira problema se outro serviço passar a compartilhar segredo. Um TTL mal digitado (ex.: `"15"` = 15 ms) passa na validação.                                                                            | `issuer`/`audience` no `sign` e no `verify` (`aud` diferente para access e refresh). `algorithms: ['HS256']` no `verify` do refresh. Validar TTL com regex e teto (ex.: access ≤ 1h, refresh ≤ 30d).                                                                                                  | P    | **Corrigido.** Ver [nota](#a-14). |
| A-15 | Baixa       | 13   | `package.json:40-41`, `:55`, `:70`                                                                                                                             | **`npm audit`: 9 vulnerabilidades (0 críticas, 6 altas, 1 moderada, 2 baixas).** Com `--omit=dev`: 4 altas, todas via `prisma@7.10.0` (CLI, peer de `@prisma/client`): `deepmerge-ts` (GHSA-ggr8-5vv4-36mx) e `mysql2` (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3). As demais vêm de `@nestjs/mau` (dev): `undici`, `tmp`, `inquirer`, `external-editor`. | Exposição de runtime baixa: `mysql2` não é usado (o banco é Postgres via `@prisma/adapter-pg`) e `deepmerge-ts` roda no carregamento de config do CLI. O `npm audit fix` sugerido faz downgrade major para Prisma 6, o que **não** é recomendado.                                                                                  | Acompanhar o patch do Prisma 7.x. Se necessário, `overrides` para `deepmerge-ts@>=8` e `mysql2@>=3.23.1`, depois de testar. Remover `@nestjs/mau` se não for usado. Rodar `npm audit --omit=dev` no CI.                                                                                                            | P    | Pendente |
| A-16 | Informativa | 2    | `src/auth/auth.service.ts:46-52`                                                                                                                               | **Signup responde 409 para email existente (trade-off registrado no código).** O tempo também difere: o 409 volta rápido, antes do Argon2, e o 201 é lento. O login está conforme (ver seção Conforme).                                                                                                                        | Enumeração de emails pelo signup, limitada a 10/min por IP. Combinada com A-01, ajuda o atacante a escolher alvos ainda não cadastrados.                                                                                                                                                                         | Aceitar enquanto não houver infraestrutura de email. Quando houver: sempre 202 com "enviamos um email", e a verificação de email resolve A-01 na raiz.                                                                                                                                                          | —    | Pendente |
| A-17 | Informativa | 5    | `src/auth/token.service.ts:92-100`                                                                                                                             | **Rotação não transacional.** O CAS revoga o token antigo e só depois `issueTokenPair` grava o novo. Se o INSERT falhar, o usuário fica com o token antigo revogado e sem sucessor.                                                                                                                                         | Raro. Nesse caso o próximo retry do cliente cai na detecção de reuso (A-04) e derruba tudo.                                                                                                                                                                                                                  | Envolver CAS + `create` numa `prisma.$transaction` (faz parte da correção de A-04).                                                                                                                                                                                                                    | P    | **Corrigido.** Ver [nota](#a-17). |
| A-18 | Informativa | 10   | `src/auth/token.service.ts:84`, `:142`, `:151`, `:155`                                                                                                         | **Mensagens de 401 distintas** ("Invalid refresh token", "Refresh token reuse detected", "Refresh token expired"), apesar do comentário na linha 84 dizer "mesmo 401 genérico".                                                                                                                                         | Quem roubou o token fica sabendo que o reuso foi detectado. Impacto mínimo.                                                                                                                                                                                                                                  | Unificar a mensagem para o cliente e manter o motivo só no log de segurança (A-07), ou corrigir o comentário.                                                                                                                                                                                       | P    | **Corrigido.** Ver [nota](#a-18). |
| A-19 | Informativa | 12   | `src/common/filters/all-exceptions.filter.ts:35-40`                                                                                                            | **O log de 5xx grava `request.url` com a query string.** No `/auth/google/callback`, isso inclui o `code` de autorização do Google.                                                                                                                                                                                       | Baixo: o `code` do Google é de uso único, expira em minutos e exige o client secret. É o único caminho encontrado em que um valor de credencial chega ao log.                                                                                                                                                             | Logar `request.path` (sem query) ou mascarar `code`/`state`.                                                                                                                                                                                                                                           | P    | **Corrigido.** Ver [nota](#a-19). |
| A-20 | Informativa | 13   | `compose.yaml:7-11`; `.env.test` (versionado)                                                                                                                   | `POSTGRES_PASSWORD` do compose tem valor fraco/padrão e a porta `5433` fica publicada em todas as interfaces. `.env.test` é versionado, mas contém só valores de teste (palavras "test" nos segredos, banco local).                                                                                                               | Postgres de dev acessível pela rede local com senha trivial.                                                                                                                                                                                                                                                 | Publicar como `127.0.0.1:5433:5432`.                                                                                                                                                                                                                                                                   | P    | **Corrigido.** Ver [nota](#a-20). |
| A-21 | Informativa | 4, 9 | `src/auth/strategies/jwt.strategy.ts:16-17`, `:31-33`; `src/auth/token.service.ts:51-54`                                                                          | Access token stateless: continua válido por até 15 min depois de logout, reuso ou exclusão do usuário (decisão documentada). Leva o `email` em claro (base64) no payload.                                                                                                                                                  | Janela de 15 min após revogação. PII em todo token, que pode ir parar em logs de terceiros.                                                                                                                                                                                                                         | Manter o TTL curto. Remover `email` do payload (buscar do banco quando precisar) ou aceitar como decisão consciente.                                                                                                                                                                                  | —    | Pendente |

---

## Item 5 — cenário mobile: resposta do refresh perdida

### Comportamento real (lido no código)

1. O app envia `R0`. `findValidRefreshToken` encontra a linha com
   `revokedAt = null` (`token.service.ts:136-158`).
2. O CAS `updateMany({ id, revokedAt: null })` marca `R0` como revogado
   (`:92-98`). Em seguida `issueTokenPair` grava `R1` (`:71-77`). O servidor
   responde 200.
3. A resposta se perde (timeout, troca de rede Wi-Fi/4G, app morto em
   background). O app continua com `R0`. O contrato manda **não** limpar a
   sessão em erro de rede (`docs/AUTH-CONTRACT-MOBILE.md:278-280`), então o
   app vai tentar de novo com `R0`.
4. Na nova tentativa, `stored.revokedAt` está preenchido, então
   `revokeAllForUser(userId)` roda (`:145-151`). Isso revoga **todas** as
   linhas do usuário com `revokedAt = null`: `R1` e também as sessões do
   browser e de outros celulares. A resposta é 401 `Refresh token reuse
   detected`.
5. O app segue o contrato (401 no refresh = sessão acabou), limpa os tokens e
   mostra o login. O usuário também é deslogado no web e nos outros aparelhos
   na próxima renovação de cada um.

**Resposta: sim, derruba todas as sessões do usuário, em todos os dispositivos.**
O mesmo vale para duas abas do Angular: cada aba tem o seu singleton
`refreshing`, ambas mandam o mesmo cookie, e a que chega depois do CAS da
outra cai no passo 4. Se as duas passarem pelo `findUnique` antes do CAS, a
perdedora recebe um 401 simples (`count === 0`, linha 96-98), sem cascata, mas
a aba pode interpretar isso como "sessão expirada".

O teste `test/auth.e2e-spec.ts:115` cobre o reuso sequencial. Não há teste de
concorrência nem de resposta perdida.

### Janela de tolerância (grace period): viável

É viável, e produtos de identidade oferecem o mesmo mecanismo (Auth0 chama de
"reuse interval", Okta de "grace period"). Proposta:

1. **Schema**: adicionar a `RefreshToken` os campos `familyId` (gerado no
   login/signup/exchange e herdado na rotação), `rotatedAt`, `successorId` e
   `graceUsedAt`.
2. **Rotação** numa `$transaction`: CAS no token atual, `create` do sucessor
   com o mesmo `familyId` e gravação de `successorId`/`rotatedAt` no antigo.
3. **Token revogado reapresentado**:
   - Se foi revogado **por rotação**, `now - rotatedAt ≤ 30–60 s`,
     `graceUsedAt` é nulo e o sucessor **ainda não foi usado** (`revokedAt`
     nulo): marcar `graceUsedAt`, revogar o sucessor e emitir um par novo na
     mesma família. Não é preciso guardar o sucessor em claro: emitir outro
     par é suficiente.
   - Nos demais casos: tratar como reuso e revogar **só a família**
     (`updateMany where familyId`), não todas as sessões do usuário. Registrar
     o evento (A-07).
4. **Risco residual**: um atacante com uma cópia de `R0` usada dentro da
   janela ganha um par. Ele fica limitado a um uso de tolerância por token, e
   o próximo refresh do dono legítimo fora da janela revoga a família e expulsa
   o atacante. Esse risco é aceitável diante do ganho de disponibilidade no
   mobile.
5. **Alternativa mais simples** (sem tolerância): só a revogação por família.
   A perda de resposta desloga apenas aquele celular, e não mais todos os
   dispositivos.

---

## Conforme

| Item | Verificação                                                                                   | Evidência                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Argon2id com m=19 MiB, t=2, p=1 (mínimo OWASP)                                                 | `src/auth/password.service.ts:16-21`                                                                                                                                                        |
| 1    | Comparação em tempo constante                                                                  | `node_modules/argon2/argon2.cjs:202` (`timingSafeEqual`), argon2 0.45.1                                                                                                                     |
| 1    | Tamanho: 8–128 no signup; login aceita 1–128 (o login não impõe política, correto)            | `src/auth/dto/signup.dto.ts:26-29`, `src/auth/dto/login.dto.ts:13-17`                                                                                                                       |
| 1    | Hash malformado vira "senha errada", não 500                                                   | `src/auth/password.service.ts:28-35`                                                                                                                                                        |
| 2    | Login: mesma resposta e mesmo custo para email inexistente, senha errada e conta só-Google (hash dummy com os mesmos parâmetros) | `src/auth/auth.service.ts:64-69`, `:167-173`; e2e `test/auth.e2e-spec.ts:84`. Só o primeiro login com email inexistente paga um hash extra (cálculo lazy, uma vez por processo) |
| 3    | Limite mais estrito em login e signup (10/min) e em import (20/min); 429 testado               | `src/auth/auth.controller.ts:59,81,113`; `src/activities/activities.controller.ts:51,100`; `test/auth.e2e-spec.ts:653`                                                                     |
| 4    | Access e refresh com segredos distintos, ≥ 32 chars, iguais rejeitados no boot                 | `src/config/env.validation.ts:42-49`, `:124-126`; `src/auth/token.service.ts:56,65,164`                                                                                                     |
| 4    | Access token: HS256 fixado, `exp` obrigatório (`ignoreExpiration: false`)                      | `src/auth/strategies/jwt.strategy.ts:22-28`                                                                                                                                                 |
| 4    | Refresh token rejeitado como Bearer                                                            | `test/auth.e2e-spec.ts:457`                                                                                                                                                                 |
| 4    | TTLs reais no `.env` local: access 15m, refresh 7d (iguais ao contrato)                          | `.env` (`JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`); `docs/API-CONTRACT.md:80-81`                                                                                                                 |
| 5    | Imprevisibilidade: `jti` UUIDv4 (122 bits aleatórios) + HMAC com segredo do servidor; forjar exige o segredo | `src/auth/token.service.ts:60-67`. Obs.: o comentário "~256 bits" (`:39`) superestima; o que torna o token impossível de adivinhar é a assinatura, e não o UUID |
| 5    | Só o SHA-256 do token no banco, com índice único                                                | `src/auth/token.service.ts:42-44,71-77`; `prisma/schema.prisma:36-48`                                                                                                                       |
| 5    | Rotação atômica (compare-and-set): duas requests com o mesmo token nunca geram dois pares      | `src/auth/token.service.ts:92-98`                                                                                                                                                           |
| 5    | Expiração checada no JWT e no banco                                                             | `src/auth/token.service.ts:134,154-156`                                                                                                                                                     |
| 6    | Cookie `HttpOnly`, `SameSite=Lax`, `Path=/auth`, sem `Domain` (host-only), `Secure` em produção | `src/auth/refresh-token-transport.service.ts:45-55`; `test/auth.e2e-spec.ts:250`                                                                                                            |
| 6    | `clearCookie` com as mesmas opções do `cookie()`; logout sem cookie ainda limpa                 | `src/auth/refresh-token-transport.service.ts:78-82`; `test/auth.e2e-spec.ts:295,312`                                                                                                        |
| 6    | Consistente com o contrato (`Set-Cookie` documentado idêntico, incluindo a divergência de Max-Age) | `docs/API-CONTRACT.md:47,50,91-94`                                                                                                                                                          |
| 6    | Defesa CSRF: cookie `Lax` + header customizado obrigatório (força preflight) + CORS de origem única | `README.md` §CSRF; `src/common/decorators/client-type.decorator.ts:27-42`; `test/auth.e2e-spec.ts:362,381`                                                                                  |
| 7    | `X-Client-Type` obrigatório, sem default, com lista fechada; header repetido rejeitado          | `src/common/decorators/client-type.decorator.ts:27-42` (+ spec)                                                                                                                             |
| 7    | Token no canal errado é 400 nos dois sentidos; um XSS na SPA não consegue extrair o refresh pelo canal mobile (com cookie é 400, sem cookie não há token) | `src/auth/refresh-token-transport.service.ts:91-115`; `test/auth.e2e-spec.ts:262,282,320`                                                                                                  |
| 7    | Refresh token nunca vai em URL, query ou log; mensagens de validação não ecoam valores; JSON malformado vira 400 com no máximo ~10 chars do corpo, devolvidos só a quem enviou | `src/auth/auth.controller.ts` (nenhum token em query); `src/auth/dto/refresh-token.dto.ts:19-21`; `node_modules/@nestjs/platform-express/adapters/express-adapter.js:375-376`             |
| 8    | Vinculação exige `email_verified` do Google, com o campo lido corretamente do perfil            | `src/auth/auth.service.ts:99-101`; `src/auth/strategies/google.strategy.ts:57-58`; `node_modules/passport-google-oauth20/lib/profile/openid.js:33`; `test/auth.e2e-spec.ts:528`               |
| 8    | Código de troca: 256 bits, só o SHA-256 no banco, TTL de 60 s, uso único por CAS, tamanho validado | `src/auth/auth.service.ts:19,125-161`; `src/auth/dto/exchange-code.dto.ts:13`; `test/auth.e2e-spec.ts:547`                                                                                  |
| 8    | Comparação do código: busca por hash em índice único; o timing não revela nada aproveitável (o atacante não controla o hash) | `src/auth/auth.service.ts:139-143`                                                                                                                                                          |
| 8    | Nenhum token na URL do redirect; destino fixo em `FRONTEND_URL` (sem open redirect)             | `src/auth/auth.controller.ts:252-260`                                                                                                                                                       |
| 9    | Logout apaga a linha no banco, é idempotente e não afeta outras sessões                          | `src/auth/token.service.ts:112-117`; `src/auth/auth.controller.ts:211-216`; `test/auth.e2e-spec.ts:142,150,158`                                                                             |
| 10   | `ValidationPipe` com `whitelist` + `forbidNonWhitelisted` + `transform`                         | `src/app.setup.ts:22-28`                                                                                                                                                                    |
| 10   | Filtro global: formato único; 5xx genérico sem mensagem nem stack para o cliente (stack só no log) | `src/common/filters/all-exceptions.filter.ts:35-50,69`                                                                                                                                      |
| 10   | Saída de usuário por whitelist explícita (sem `passwordHash` nem `googleId`)                     | `src/users/dto/user-response.dto.ts:41-51`                                                                                                                                                  |
| 11   | CORS com origem única e `credentials: true`; origem arbitrária não é refletida                   | `src/app.setup.ts:37-40`; `test/auth.e2e-spec.ts:381`                                                                                                                                       |
| 11   | Limite de corpo: padrão do body-parser (100 KB), sem override; upload com teto de 10 MiB, 1 arquivo e 10 campos | `node_modules/@nestjs/platform-express/adapters/utils/get-body-parser-options.util.js` (sem `limit`); `src/activities/activities.controller.ts:139`                                        |
| 12   | Nenhum log de senha, token ou email; logs só de 5xx e de chaves do storage (userId + UUID)        | `src/common/filters/all-exceptions.filter.ts:35-40`; `src/activities/activities.service.ts:114-117,150-153`                                                                                |
| 13   | `.env` no `.gitignore` e nunca versionado; nenhum valor de segredo do `.env` local aparece no histórico do git | `.gitignore:42`; `git log --all -- .env` vazio. Busca dos valores no `git log -p` só teve correspondência para `GOOGLE_CLIENT_SECRET`, que é o placeholder idêntico ao `.env.example` |
| 13   | `.env.example` só com placeholders (frases "troque-…", "xxx", chaves de exemplo)                 | Análise por palavras-chave e tamanho, sem imprimir valores                                                                                                                                  |
| 14   | `/activities/*` exige Bearer (sem `@Public()`; guard global)                                    | `src/activities/activities.controller.ts:63-69`; `src/auth/auth.module.ts:36`                                                                                                               |
| 14   | Sem IDOR: toda consulta filtra por `userId` do token; 404 idêntico para "não existe" e "é de outro usuário" | `src/activities/activities.service.ts:53-62,77-79`; `src/activities/activities.controller.ts:168-181`                                                                                       |
| 14   | Chave do objeto no bucket montada pelo servidor (`activities/{userId do token}/{UUID gerado}.fit`); campos do formulário ignorados | `src/activities/activities.service.ts:108-109`; `src/activities/storage/activity-file-storage.service.ts:47-49`; `src/activities/activities.controller.ts:152-156`                      |

---

## Não verificado

| Tema                                                           | Motivo / o que faltou                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topologia de produção na Oracle VM (proxy reverso, LB, terminação TLS, HSTS no proxy, quantos saltos) | Não há configuração de deploy no repositório. Define o valor correto de `trust proxy` (A-03) e se o HSTS já é aplicado fora da app (A-06).                                                                           |
| Valores reais de produção (segredos, `NODE_ENV`, TTLs, `FRONTEND_URL`) | Só o `.env` local foi analisado. A-05 e A-11 dependem deles.                                                                                                                                                              |
| Se o `DATABASE_URL` do `.env` local aponta para o banco de produção | Ele aponta para um host remoto com `sslmode=require`. Não dá para saber se é o mesmo banco de produção. Se for, a máquina de dev guarda credenciais de produção.                                                      |
| Verificação do certificado TLS do Postgres                      | `sslmode=require` e o comportamento do `pg`/`pg-connection-string` instalado não foram testados em runtime.                                                                                                           |
| Configuração no Google Cloud Console                           | Redirect URIs autorizadas, tela de consentimento e escopos publicados ficam fora do repositório.                                                                                                                      |
| Bucket OCI (acesso público, PARs, criptografia, versionamento) | Fora do repositório. Só a construção da chave foi verificada.                                                                                                                                                          |
| Medição de timing real do login                                | A equivalência foi analisada só de forma estática. A app não foi executada (auditoria somente leitura, sem banco).                                                                                                   |
| Frontend Angular e app Android                                  | Fora do repositório. Faltou ver o `Referrer-Policy` e a limpeza do `?code=` da URL na rota `/auth/callback`, o singleton de refresh entre abas, o armazenamento no Keystore e o tratamento de erro de rede no Authenticator. |
| Varredura completa de segredos no histórico git (gitleaks/trufflehog) | Ferramenta não instalada e fora do escopo "sem rede além do npm audit". Foi feita só a busca dos valores atuais do `.env` no `git log -p`.                                                                          |
| Testes (unit/e2e) executados                                    | Não foram rodados: o e2e exige Postgres e trunca tabelas. As afirmações sobre testes citam o que o código dos testes verifica, não resultados de execução.                                                          |

---

## Ordem de prioridade sugerida

### 1. Bloqueia produção

1. **A-01** — descartar a senha e revogar sessões ao vincular Google em conta não verificada. P.
2. **A-05** — boot recusa segredos placeholder ou fracos; `NODE_ENV` obrigatório. P.
3. **A-03** — `trust proxy` correto para a topologia da VM, mais limite por conta no login. M.
4. **A-06** — Helmet (HSTS, nosniff, CSP/frame-ancestors) e remoção do `X-Powered-By`. P.
5. **A-02** — `state` + PKCE no fluxo Google. M.

### 2. Antes de lançar o app Android (ou nas primeiras semanas de produção)

6. **A-04** + **A-17** — família de tokens, revogação por família, grace period e rotação em transação. M.
7. **A-07** — log estruturado de eventos de segurança, com alerta de reuso. P.
8. **A-08** — `POST /auth/logout-all`. P.
9. **A-13** — redirecionar cancelamentos e erros do Google para o frontend. P.
10. **A-11** — `Secure` por padrão e `maxAge` derivado do token. P.

### 3. Melhorias

11. **A-09** — mínimo 12 ou checagem de vazadas; NFKC. P.
12. **A-10** — Swagger fora de produção. P.
13. **A-14** — `iss`/`aud`, HS256 no verify do refresh, validação de TTL. P.
14. **A-12** — job de limpeza. P.
15. **A-15** — acompanhar o patch do Prisma; `npm audit --omit=dev` no CI. P.
16. **A-18**, **A-19**, **A-20**, **A-21**, **A-16** — ajustes pontuais e decisões a registrar.

---

## Notas de correção

Uma nota por achado tratado depois da auditoria. O texto original dos achados
acima não foi alterado. As referências de arquivo apontam para o código atual.

### A-01

**O que mudou.** `loginWithGoogle` (`src/auth/auth.service.ts`) agora separa
os dois casos de vinculação por email:

- Conta local com `emailVerified: false`: `takeOverUnverifiedAccount` roda
  numa única `$transaction`. Apaga todos os `RefreshToken` e
  `OAuthExchangeCode` do usuário, depois chama `linkGoogleAccount` com
  `discardPassword: true` (`src/users/users.service.ts`), que zera o
  `passwordHash` e marca `emailVerified: true`. A conta passa a ser só-Google.
- Conta com email já verificado: vincula como antes e mantém a senha e as
  sessões.

Os refresh tokens são **apagados**, não marcados com `revokedAt`. Um token
revogado que volta a ser apresentado aciona a detecção de reuso (A-04), e
quem fez o cadastro original poderia usá-lo para derrubar as sessões da dona
da conta quantas vezes quisesse. Apagado, o token volta a dar um 401 simples.

Cobertura: `test/auth.e2e-spec.ts` (cenário de pre-hijacking e conta
verificada que mantém a senha) e `src/auth/auth.service.spec.ts`. Os
contratos (`docs/API-CONTRACT.md`, `docs/AUTH-CONTRACT-MOBILE.md`) já
descrevem o novo comportamento.

**Riscos residuais:**

- O access token que o atacante já tinha continua válido até expirar (no
  máximo `JWT_ACCESS_TTL`, 15 min; ver A-21).
- Corrida entre um login por senha concorrente e a vinculação: se o login já
  verificou a senha antes da transação e grava o refresh token depois dela, o
  token novo sobrevive. Mitigação futura: um contador `credentialsVersion` no
  usuário, incrementado na vinculação e conferido na emissão. Está no backlog
  junto do A-04.
- Os dados que o atacante pré-cadastrou (nome, atividades importadas) são
  herdados pela dona da conta.

### A-02

**O que mudou.** A `GoogleStrategy` (`src/auth/strategies/google.strategy.ts`)
usa `state: true` e `pkce: true` (S256) com um store próprio,
`OAuthStateStore` (`src/auth/oauth-state.store.ts`), já que a sessão está
desligada. No `GET /auth/google`, o store grava o `state` (256 bits) e o
`code_verifier` no cookie `googleOAuthState`: `HttpOnly`, `SameSite=Lax`,
`Path=/auth/google`, `Secure` conforme `COOKIE_SECURE`, 10 minutos. O cookie é
assinado com HMAC-SHA256, com a expiração dentro do payload assinado
(`src/auth/oauth-state-cookie.ts`). A chave é derivada do `JWT_SECRET` por
HKDF com rótulo próprio, sem variável nova. No callback, o
`GoogleCallbackGuard` (`src/auth/guards/google-callback.guard.ts`) apaga o
cookie em qualquer desfecho, o store compara o `state` em tempo constante e a
troca do `code` leva o verifier. Cobertura: `test/google-oauth.e2e-spec.ts`,
`src/auth/oauth-state.store.spec.ts`, `src/auth/oauth-state-cookie.spec.ts` e
`src/auth/guards/google-callback.guard.spec.ts`.

**Observação:** dois logins iniciados no mesmo navegador valem o último. O
callback do primeiro volta com `state_mismatch`.

**Risco aceito:** um callback forjado que chegue no meio de um login legítimo
(por exemplo, um link do atacante aberto pela vítima) dá `state_mismatch` e
apaga o cookie, então o login legítimo em curso também termina em
`state_mismatch`. O atacante não ganha acesso, só obriga a vítima a repetir o
login.

### A-03

**O que mudou.**

- **`TRUST_PROXY` configurável** (`parseTrustProxy` em
  `src/config/env.validation.ts`, aplicado em `src/app.setup.ts`): aceita um
  número de saltos, uma lista de IPs/CIDRs ou os nomes pré-definidos do
  Express (`loopback`, `linklocal`, `uniquelocal`). `true`, `*` e faixas que
  cobrem todos os endereços são recusados no boot. Fica desligado por padrão,
  e em produção sem a variável o boot emite um warn (`warnAboutTrustProxy`).
- **Limite por conta no login** (`src/auth/login-attempts.service.ts`): a
  chave é o SHA-256 do email normalizado, aplicada exista ou não a conta.
  Passando de `LOGIN_MAX_FAILURES` (padrão 5) dentro de
  `LOGIN_FAILURE_WINDOW_MINUTES` (padrão 15), o login daquele email responde
  429 até a janela acabar. O 429 é idêntico ao do limite por IP (mesma
  exceção e mesma mensagem), com `Retry-After`.
- **Limites por rota**: login e signup 10/min, refresh e logout 30/min,
  `google/exchange` e `logout-all` 20/min (`src/auth/auth.controller.ts`),
  import 20/min (`src/activities/activities.controller.ts`).
- **Log**: o evento `rate_limited` registra o `path` (sem query string) e,
  no limite por conta, `reason: account_login_limit`.

Cobertura: `test/rate-limit.e2e-spec.ts`, `src/auth/login-attempts.service.spec.ts`,
`src/config/env.validation.spec.ts`, `src/app.setup.spec.ts` e
`src/common/filters/all-exceptions.filter.spec.ts`.

**Riscos aceitos e pendências:**

1. **DoS de conta.** Quem souber o email de alguém pode travar o login por
   senha dessa pessoa por até uma janela. Mitigado pelo limite de 5, pela
   janela de 15 min e pelo 429 igual para todos. Só afeta `POST /auth/login`:
   não impede refresh, login com Google nem o login de outros emails.
2. **Store em memória** (`InMemoryLoginAttemptsStore`): por processo, zera no
   restart e não é compartilhado entre instâncias. A interface
   `LoginAttemptsStore` está pronta para trocar por Redis.
3. **Teto de 50 mil chaves**: com o mapa cheio, a janela mais antiga é
   descartada. Um atacante com muitos IPs poderia encher o mapa e apagar a
   contagem de um alvo.
4. O 429 por conta carrega os headers `X-RateLimit-*` do limite por IP.
5. Backoff progressivo não implementado.
6. O 409 do signup concorrente (P2002, traduzido pelo `AllExceptionsFilter`)
   não gera `signup_conflict`.

**Pendência operacional:** o valor de `TRUST_PROXY` só deve ser definido na
VM, depois de confirmar a topologia do proxy (por exemplo, `1` para um único
proxy na frente da API). Enquanto estiver desligado, o `ip` dos logs e dos
limites é o do proxy.

### A-04

**O que mudou.** `RefreshToken` ganhou `familyId`, `rotatedAt`, `successorId`
e `graceUsedAt` (`prisma/schema.prisma`). Login, signup e troca do código do
Google abrem uma família nova, e a rotação a herda
(`src/auth/token.service.ts`). Um token rotacionado que volta a aparecer
(`handleRotatedToken`) segue um destes caminhos:

- **Janela de tolerância**: vale se o token foi rotacionado há no máximo
  `REFRESH_GRACE_SECONDS` (padrão 30, máximo 60, 0 desativa;
  `src/config/env.validation.ts`), se a tolerância ainda não foi usada (CAS
  em `graceUsedAt`) e se o sucessor continua ativo, sem ter rotacionado. Nesse
  caso o servidor emite um token irmão na mesma família e não invalida o
  sucessor, ao contrário da proposta do item 5. O evento
  `refresh_grace_used` é registrado como warn.
- **Sucessor apagado** (logout, A-01): 401 simples, sem efeito colateral.
- **Reuso real**: o servidor registra `refresh_reuse_detected` e apaga só as
  linhas da família, ou seja, a sessão daquele dispositivo. As outras sessões
  do usuário continuam valendo. `revokeAllForUser` foi removido.

O log de segurança passou a levar o `familyId`. A migration
`refresh_token_families` faz backfill: cada token existente vira a sua
própria família. Cobertura: `test/refresh-token-families.e2e-spec.ts` (web e
mobile, inclusive a corrida concorrente), `test/migrations.e2e-spec.ts`,
`src/auth/token.service.spec.ts` e `src/config/env.validation.spec.ts`. Os
contratos (`docs/API-CONTRACT.md`, `docs/AUTH-CONTRACT-MOBILE.md`) e o
`README.md` foram atualizados.

**Riscos residuais:**

- Quem tiver uma cópia de um token recém-rotacionado e usá-la dentro da janela
  ganha um par independente, e o dono não recebe nenhum aviso. Mitigação:
  configurar um alerta em `refresh_grace_used`.
- Se uma aba renovar duas vezes em menos de 30 s e outra aba apresentar o
  token original, o sucessor já rotacionou: conta como reuso e a família é
  apagada.
- O `credentialsVersion` do A-01 continua no backlog.

**Deploy:** aplique a migration com `prisma migrate deploy` antes de subir o
código novo, que depende das colunas novas.

**Para o A-08 e o A-12:** o logout-all e o job de limpeza devem **apagar** as
linhas, não marcar `revokedAt`. Se só marcar, um token reapresentado ainda
passaria pela janela de tolerância e ganharia um par novo.

### A-05

**O que mudou.** Em `src/config/env.validation.ts`, `NODE_ENV` é obrigatório,
sem default (`development`, `test` ou `production`). Os scripts do
`package.json` definem o valor de cada modo. Com `NODE_ENV=production`, o boot
também exige `JWT_SECRET` e `JWT_REFRESH_SECRET` com pelo menos 43 caracteres
e recusa credenciais (`JWT_*`, `DATABASE_URL`, `GOOGLE_CLIENT_*`,
`OCI_S3_ACCESS_KEY`/`OCI_S3_SECRET_KEY`) que contenham trechos dos
placeholders do `.env.example`, sem diferenciar maiúsculas. As mensagens de
erro dizem a variável e o motivo, nunca o valor. Cobertura:
`src/config/env.validation.spec.ts`.

**Risco aceito:** não há checagem de entropia. Um segredo legível e longo,
sem as palavras bloqueadas, ainda passa em produção. A documentação
(`README.md`, `.env.example`) manda gerar com `randomBytes(48)`.

**Observação:** um segredo aleatório pode, raramente (cerca de 0,2% por
segredo gerado), conter uma palavra bloqueada e ser rejeitado no boot. Nesse
caso basta gerar outro.

### A-06

**O que mudou.** O helmet é o primeiro middleware (`src/app.setup.ts`), com
HSTS emitido pela app, CSP com `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer` e sem
`X-Powered-By`. Detalhes na coluna Status da tabela. Cobertura:
`test/security-headers.e2e-spec.ts`.

### A-07

**O que mudou.** O novo `SecurityLogService`
(`src/security/security-log.service.ts`) grava uma linha JSON por evento, com
contexto `SecurityLog`: `event`, `timestamp`, `userId`, `ip`, `userAgent`
truncado, `clientType`, email mascarado e um `reason` de lista fixa. Nunca
grava senha, token, código de troca, hash nem URL. Os eventos de login,
refresh, reuso, logout, vinculação e troca Google saem de
`src/auth/auth.service.ts` e `src/auth/token.service.ts`. O 429 e as falhas
do callback do Google saem do `AllExceptionsFilter`. `SECURITY_LOG_ENABLED`
(padrão `true`) desliga o log nos testes. A lista de eventos e os alertas
sugeridos estão no `README.md` ("Logs de segurança"). Cobertura:
`src/security/security-log.service.spec.ts` e
`test/security-log.e2e-spec.ts`.

**Riscos residuais:**

- `ip` é o `req.ip`, que depende do `TRUST_PROXY` (A-03). Enquanto ele
  estiver desligado, atrás de proxy, é o IP do proxy, não o do cliente.
- Desde o A-03, o `rate_limited` registra o `path` da rota, e o signup
  recusado com 409 (email já cadastrado) gera o evento `signup_conflict`,
  exceto no signup concorrente (ver A-03).
- Os alertas estão só documentados; nenhum está configurado.

### A-10

**O que mudou.** O Swagger só é registrado fora de produção
(`shouldSetupSwagger` em `src/app.setup.ts`). Em produção, `/docs`,
`/docs-json` e `/docs-yaml` respondem 404. Cobertura:
`test/swagger-by-env.e2e-spec.ts`.

### A-11

**O que mudou.** A nova variável `COOKIE_SECURE` (padrão `true`, aceita só
`"true"`/`"false"`) controla a flag `Secure` do cookie, independente de
`NODE_ENV`. Com `NODE_ENV=production`, `COOKIE_SECURE=false` é recusado no
boot (`src/config/env.validation.ts`), então o `Secure` é obrigatório em
produção. O `Max-Age` passou a ser derivado do `exp` do refresh token emitido
(`refreshTokenExpiresAt` em `src/auth/token.service.ts`, usado em
`src/auth/refresh-token-transport.service.ts`) e acompanha qualquer
`JWT_REFRESH_TTL`. O `clearCookie` usa as mesmas opções do `cookie()`.
Cobertura: `test/refresh-cookie-by-env.e2e-spec.ts` e
`src/auth/refresh-token-transport.service.spec.ts`.

**Risco aceito:** o cookie continua se chamando `refreshToken`, sem o prefixo
`__Secure-`. O prefixo quebraria o dev em `http://` (o browser recusa um
cookie `__Secure-` sem `Secure`) e mudaria o contrato com o frontend.

**Observação:** o Safari não guarda cookie `Secure` vindo de
`http://localhost`. Para usar o Safari em dev, defina `COOKIE_SECURE=false`
no `.env` local.

### A-13

**O que mudou.** Toda falha do `GET /auth/google/callback` termina em
`302 ${FRONTEND_URL}/auth/callback?error=<código>`, com um código de lista
fixa (`src/auth/google-callback.ts`): `access_denied`, `email_not_verified`,
`state_mismatch` ou `oauth_failed`. Nada que o Google manda
(`error_description` etc.) é repassado. O `GoogleCallbackGuard` classifica a
falha e o `GoogleCallbackFilter` (`src/auth/filters/google-callback.filter.ts`)
faz o redirect e registra `google_exchange_failed` no log de segurança, com o
código no `reason`. `code` inválido, outro `error=` do Google e callback sem
`code` nem `error` viram `oauth_failed`, sem 500 e sem stack no log. Cobertura:
`test/google-oauth.e2e-spec.ts`, `src/auth/filters/google-callback.filter.spec.ts`
e `src/auth/guards/google-callback.guard.spec.ts`.

**Observações:**

- O 429 no callback continua em JSON. O throttler é um guard global e roda
  antes do guard do callback, e o `GoogleCallbackFilter` só pega as falhas
  já classificadas. O 429 segue pelo `AllExceptionsFilter`, como em qualquer
  rota.
- Um erro interno inesperado (banco fora, bug) também vira `oauth_failed`
  para o usuário. O stack vai para o log com `request.path`, sem a query
  (A-19).

### A-14

**O que mudou.** Os dois tokens são assinados e verificados com HS256, `iss`
(`JWT_ISSUER`) e um `aud` próprio do tipo (`dutrail-access` ou
`dutrail-refresh`), definidos em `src/auth/jwt.constants.ts` e aplicados em
`src/auth/token.service.ts` e `src/auth/strategies/jwt.strategy.ts`. O verify
do refresh agora fixa o algoritmo. Em `src/config/env.validation.ts`, os TTLs
só aceitam inteiro + unidade (`s`, `m`, `h`, `d`), com teto de 1h para o
access e 30d para o refresh. Cobertura: `src/auth/token.service.spec.ts`,
`src/config/env.validation.spec.ts`, `test/auth.e2e-spec.ts` e
`test/jwt-env.e2e-spec.ts`.

**Observações:**

- Os tokens emitidos antes da mudança, sem `iss`/`aud`, deixaram de valer:
  todo usuário precisa fazer login de novo uma vez. O mesmo acontece sempre
  que `JWT_ISSUER` mudar.
- `JWT_ISSUER` é opcional, com padrão `dutrail-api`.

### A-17

**O que mudou.** A rotação (`rotateRefreshToken` em
`src/auth/token.service.ts`) roda numa `prisma.$transaction` só, com o CAS no
token atual, o `create` do sucessor e a gravação de `successorId`. Se o
INSERT falhar, o CAS é desfeito e o token enviado continua ativo, então o
retry do cliente funciona sem cair na detecção de reuso. A emissão pela janela
de tolerância (A-04) também é transacional. Cobertura:
`test/refresh-token-families.e2e-spec.ts` e `src/auth/token.service.spec.ts`.

### A-18

**O que mudou.** Toda recusa de um refresh token recebido (JWT inválido ou
expirado, não encontrado, reuso, rotação concorrente) responde 401 com a
mesma mensagem, `Invalid refresh token` (`INVALID_REFRESH_TOKEN_MESSAGE` em
`src/auth/jwt.constants.ts`, usada em `src/auth/token.service.ts`). Token
ausente continua com `Missing refresh token`. Os contratos
(`docs/API-CONTRACT.md`, `docs/AUTH-CONTRACT-MOBILE.md`) foram atualizados.
Cobertura: `test/security-log.e2e-spec.ts`, `test/auth.e2e-spec.ts` e
`src/auth/token.service.spec.ts`.

**Observações:**

- O motivo específico da recusa segue só no log de segurança (A-07), no
  campo `reason` ou no evento `refresh_reuse_detected`.
- A rotação concorrente tem só cobertura unitária
  (`src/auth/token.service.spec.ts`); nenhum e2e reproduz a corrida.

### A-19

**O que mudou.** O `AllExceptionsFilter`
(`src/common/filters/all-exceptions.filter.ts`) loga os 5xx com
`request.path`, sem a query string. O `code` e o `state` do
`/auth/google/callback` não chegam mais ao log. Cobertura:
`src/common/filters/all-exceptions.filter.spec.ts` e `test/auth.e2e-spec.ts`.

**Risco aceito:** o campo `path` do corpo da resposta de erro ainda usa
`request.url`, com a query string. Ele volta só para o cliente que fez a
request e não vai para o log.

### A-20

**O que mudou.** O `compose.yaml` publica o Postgres em
`127.0.0.1:5433:5432`, só no loopback. A senha pode ser trocada com
`POSTGRES_PASSWORD` no ambiente (vale na criação do volume).

**Risco aceito:** a senha padrão `dutrail` é fraca, mas o acesso fica
restrito ao loopback da máquina de dev.

**Pendência operacional:** um container criado antes da mudança continua
escutando em `0.0.0.0` até ser recriado (`podman compose down` +
`podman compose up -d`; o volume `pgdata` é preservado). Para verificar:

```bash
podman ps --format '{{.Names}} {{.Ports}}'
```

O esperado é `127.0.0.1:5433->5432/tcp`.

---

## Impacto no dutrail-web

Mudanças da API que o frontend Angular precisa absorver:

- **`hasPassword` pode passar a `false` depois do login com Google (A-01).**
  Quando a conta local tinha email não verificado, a vinculação apaga a senha
  e as sessões, e `user.hasPassword` volta `false` em `/me` e nas respostas de
  login. Nesses casos o front não deve oferecer login por senha (nem troca de
  senha) para essa conta. Ainda não existe fluxo para definir uma senha nova.
  Outras sessões web dessa conta recebem 401 no próximo `/auth/refresh` e
  devem voltar ao login.
- **Cookie do refresh com `Secure` por padrão e `Max-Age` real (A-11).** O
  `Set-Cookie` agora traz `Secure` também em dev, e o `Max-Age` segue a
  validade real do token (`JWT_REFRESH_TTL`), não mais 7 dias fixos. O nome
  (`refreshToken`), o `Path=/auth` e o `SameSite=Lax` não mudaram. Chrome e
  Firefox aceitam cookie `Secure` em `http://localhost`. No Safari é preciso
  `COOKIE_SECURE=false` no `.env` local da API.
- **Swagger não existe em produção (A-10).** `/docs`, `/docs-json` e
  `/docs-yaml` respondem 404 com `NODE_ENV=production`. O front não deve
  depender de `/docs-json` em produção (por exemplo, para gerar clientes em
  runtime). A geração de tipos deve rodar contra a API de dev ou contra os
  contratos em `docs/`.
- **Tratar `?error=` na rota `/auth/callback` (A-02, A-13).** O callback do
  Google não termina mais em JSON na API. Toda falha volta para
  `/auth/callback?error=<código>`, sem `code`. Os códigos possíveis são
  `access_denied`, `email_not_verified`, `state_mismatch` e `oauth_failed`
  (o que mostrar em cada caso está em `docs/API-CONTRACT.md`, "Erros do
  callback").
- **Interceptor do refresh: deslogar só em 401 (A-04).** Um 401 no
  `/auth/refresh` encerra a sessão local. Em erro de rede (status 0), o
  interceptor não desloga: repete o refresh uma vez, porque a renovação pode
  ter acontecido e a resposta se perdido. O retry cai na janela de tolerância.
  O exemplo está em `docs/API-CONTRACT.md`.

## Impacto no App Android

Mudanças da API que o app Android precisa absorver:

- **Retry do refresh com o mesmo token (A-04).** O `Authenticator` deve seguir
  a orientação nova de `docs/AUTH-CONTRACT-MOBILE.md` ("Erro de rede no
  refresh"). Em erro de rede, mantém o refresh token enviado e repete
  `/auth/refresh` uma vez com o **mesmo** token, logo em seguida e ainda dentro
  do lock, para cair na janela de tolerância. Só um 401 limpa a sessão.
  Um reuso detectado encerra só a sessão daquele aparelho.
