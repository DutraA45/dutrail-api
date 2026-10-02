# Contrato da API de Autenticação — Dutrail

Referência para quem consome esta API (frontend Angular e, futuramente, o app
Android nativo em Kotlin). Espelha o comportamento verificado pelos testes em
[`test/auth.e2e-spec.ts`](../test/auth.e2e-spec.ts), que rodam os mesmos
cenários para os dois tipos de cliente; a documentação interativa fica em
`/docs` e o OpenAPI JSON em `/docs-json`.

> **Em produção, `/docs` e `/docs-json` não existem (404).** O Swagger só é
> registrado com `NODE_ENV` diferente de `production`; em produção, este
> documento é a referência.

As rotas de atividades (`/activities`) estão em
[`ACTIVITIES-CONTRACT.md`](ACTIVITIES-CONTRACT.md); os padrões descritos aqui
(Bearer, formato de erro, interceptor) valem para elas também.

O **access token** sempre vai no corpo JSON e volta em
`Authorization: Bearer <accessToken>`. O **refresh token** tem dois transportes,
escolhidos pelo header obrigatório `X-Client-Type`:

| `X-Client-Type` | Refresh token trafega em             | Cliente                         |
| --------------- | ------------------------------------ | ------------------------------- |
| `web`           | Cookie `httpOnly` (o cliente não vê) | Angular                         |
| `mobile`        | Corpo JSON                           | App Android, Kotlin (e cURL/CI) |

Base em desenvolvimento: `http://localhost:3000`; CORS liberado apenas para a
origem em `FRONTEND_URL` (`http://localhost:4200`), com `credentials: true`.

## X-Client-Type é obrigatório

Nas rotas que emitem ou leem o refresh token (`/auth/signup`, `/auth/login`,
`/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/google/exchange`):

| Header                             | Resposta                                               |
| ---------------------------------- | ------------------------------------------------------ |
| `X-Client-Type: web` ou `mobile`   | Fluxo normal (case-insensitive, espaços são ignorados) |
| Ausente                            | **400** `x-client-type header is required...`          |
| Valor desconhecido (ex. `desktop`) | **400** `x-client-type header must be one of...`       |

Não há default silencioso. `GET /auth/google`, `GET /auth/google/callback` e
`GET /me` **não** aceitam nem exigem o header (as duas primeiras são navegação
de browser, que não permite headers customizados).

## Os dois fluxos lado a lado

|                                | `web`                                                                                           | `mobile`                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Configuração do cliente        | `withCredentials: true` em todas as chamadas                                                    | Nada (sem cookies)                                                                                   |
| Corpo de signup/login/exchange | `{ accessToken, user }`                                                                         | `{ accessToken, refreshToken, user }`                                                                |
| Corpo de `/auth/refresh`       | `{ accessToken }`                                                                               | `{ accessToken, refreshToken }`                                                                      |
| `Set-Cookie` na resposta       | `refreshToken=...; Max-Age=<validade do token (s)>; Path=/auth; HttpOnly; Secure; SameSite=Lax` | nunca                                                                                                |
| Enviar o refresh token         | Automático (cookie); corpo deve ficar **vazio**                                                 | `{ "refreshToken": "eyJ..." }` no corpo                                                              |
| Token no canal errado          | Corpo preenchido → **400**                                                                      | Cookie `refreshToken` presente → **400**                                                             |
| Logout                         | Revoga no banco + apaga o cookie (`Set-Cookie: refreshToken=; Expires=1970`)                    | Revoga no banco                                                                                      |
| Logout de todos os dispositivos | Bearer; encerra todas as sessões + apaga o cookie deste browser                                | Bearer; encerra todas as sessões                                                                     |
| Onde o cliente guarda          | Em nenhum lugar — o cookie é `httpOnly`                                                         | Armazenamento seguro do Android (Android Keystore protegendo os tokens, ex. DataStore criptografado) |

Rotação, detecção de reuso e revogação são **idênticas** nos dois: só o
transporte muda. O banco guarda apenas o SHA-256 do token nos dois casos.

Nenhuma resposta contém senha, hash de senha ou `googleId`. O objeto `user` é
sempre este:

```json
{
  "id": "c7a3d2f4-8b1e-4c7a-9f3d-2e1b5a6c8d9e",
  "email": "ana@example.com",
  "name": "Ana",
  "avatarUrl": null,
  "emailVerified": false,
  "hasPassword": true,
  "createdAt": "2026-09-21T19:26:10.085Z"
}
```

`hasPassword: false` identifica conta sem senha: criada via Google, ou conta
local com email não verificado cuja senha foi descartada ao ser vinculada ao
Google (ver [Login com Google](#login-com-google)).

## Validade dos tokens

Os valores abaixo são o **padrão, configurável por variável de ambiente** no
servidor; não são garantia e podem mudar por ambiente.

| Token   | Variável          | Padrão     |
| ------- | ----------------- | ---------- |
| Access  | `JWT_ACCESS_TTL`  | 15 minutos |
| Refresh | `JWT_REFRESH_TTL` | 7 dias     |
| Repetição do refresh já usado (tolerância) | `REFRESH_GRACE_SECONDS` | 30 segundos (máximo 60; 0 desativa) |

A validade do refresh token é uma **janela deslizante**, igual nos dois fluxos:
cada chamada bem-sucedida a `/auth/refresh` emite um refresh token novo com a
validade completa contada a partir daquele momento, e não herda o prazo do login
original. Não há limite absoluto de duração da sessão: ela só expira se o
cliente passar um período inteiro de `JWT_REFRESH_TTL` sem renovar, ou se for
encerrada (logout, logout de todos os dispositivos, ou detecção de reuso naquela
sessão). Por isso o cliente não
precisa agendar renovação: basta renovar ao receber 401 (ver
[Interceptor](#interceptor)).

### Sessões e janela de tolerância

Cada login (senha, signup ou Google) abre uma **sessão própria daquele
cliente** (um browser, um celular), e as renovações dela continuam na mesma
sessão. Igual nos dois fluxos.

Um refresh token que acabou de ser trocado em `/auth/refresh` ainda pode ser
reapresentado **uma única vez**, por até `REFRESH_GRACE_SECONDS` (30 segundos
no padrão) contados daquela troca, e recebe um par novo e válido da mesma
sessão. Isso cobre:

- **resposta perdida**: o servidor renovou, mas a resposta não chegou
  (timeout, troca de rede). O cliente ainda tem o token antigo: no web, o
  cookie não foi sobrescrito; no mobile, o token salvo. Um erro de rede no
  refresh **pode ser repetido com o mesmo refresh token** dentro da janela;
- **duas abas** renovando ao mesmo tempo com o mesmo cookie: as duas recebem
  um par válido, e nenhuma é deslogada.

Fora disso, reapresentar um refresh token já usado é **reuso** (o servidor
interpreta como roubo): ele encerra **a sessão daquele cliente** (todos os
tokens dela) e responde 401 `Invalid refresh token`. As sessões do mesmo
usuário em outros dispositivos **não** são afetadas. Contam como reuso: repetir
depois da janela, repetir o mesmo token pela segunda vez (a tolerância vale uma
vez) e repetir um token depois que o seu substituto já foi usado num refresh.
Fora da janela, portanto, o 401 encerra a sessão local.

No web, três ou mais abas renovando exatamente ao mesmo tempo esgotam a
tolerância e derrubam a sessão do browser. Se o app abrir muitas abas,
serialize o refresh entre elas (por exemplo, com a Web Locks API,
`navigator.locks.request('refresh', ...)`).

No fluxo web, o `Max-Age` do cookie acompanha a validade real do refresh token
emitido (o `exp` do JWT, que segue `JWT_REFRESH_TTL`): o browser descarta o
cookie quando o token expira, e cada `/auth/refresh` renova os dois. Com o
padrão de 7 dias, `Max-Age` fica em torno de 604800, normalmente um pouco
abaixo (conta o tempo restante até o `exp`, em segundos inteiros).

O cookie sai com `Secure` por padrão, ou seja, o browser só o envia por HTTPS.
A exceção é o desenvolvimento local em `http://` com Safari, que recusa cookie
`Secure` fora de HTTPS (Chrome e Firefox o aceitam em `http://localhost`): o
servidor omite a flag se `COOKIE_SECURE=false`, configuração que o boot recusa
em produção.

## Endpoints

| Método | Rota                    | `X-Client-Type` | Corpo enviado                         | Sucesso | Resposta                                   |
| ------ | ----------------------- | --------------- | ------------------------------------- | ------- | ------------------------------------------ |
| POST   | `/auth/signup`          | obrigatório     | `email`, `password`, `name?`          | 201     | access (+ refresh se mobile) + `user`      |
| POST   | `/auth/login`           | obrigatório     | `email`, `password`                   | 200     | access (+ refresh se mobile) + `user`      |
| POST   | `/auth/refresh`         | obrigatório     | vazio (web) / `refreshToken` (mobile) | 200     | access (+ refresh se mobile)               |
| POST   | `/auth/logout`          | obrigatório     | vazio (web) / `refreshToken` (mobile) | 204     | corpo vazio                                |
| POST   | `/auth/logout-all`      | obrigatório     | vazio (Bearer)                        | 204     | corpo vazio                                |
| GET    | `/auth/google`          | —               | —                                     | 302     | redirect para o Google (+ cookie de state) |
| POST   | `/auth/google/exchange` | obrigatório     | `code`                                | 200     | access (+ refresh se mobile) + `user`      |
| GET    | `/me`                   | —               | — (Bearer)                            | 200     | apenas `user`                              |

A validação rejeita campos desconhecidos: enviar `name` em `/auth/login`
retorna **400**, não é ignorado. `email` é normalizado no servidor (trim +
minúsculas); `password` tem entre 8 e 128 caracteres no cadastro.

### Exemplos — fluxo web

```http
POST /auth/login
Content-Type: application/json
X-Client-Type: web

{ "email": "ana@example.com", "password": "S3nh@Forte!" }
```

```http
HTTP/1.1 200 OK
Set-Cookie: refreshToken=eyJhbGciOi...; Max-Age=604800; Path=/auth; HttpOnly; Secure; SameSite=Lax

{ "accessToken": "eyJhbGciOiJIUzI1NiJ9...", "user": { ... } }
```

```http
POST /auth/refresh
X-Client-Type: web
Cookie: refreshToken=eyJhbGciOi...        ← o browser envia sozinho

HTTP/1.1 200 OK
Set-Cookie: refreshToken=<novo>; Max-Age=604800; Path=/auth; HttpOnly; Secure; SameSite=Lax

{ "accessToken": "eyJ..." }
```

### Exemplos — fluxo mobile

```http
POST /auth/login
Content-Type: application/json
X-Client-Type: mobile

{ "email": "ana@example.com", "password": "S3nh@Forte!" }
```

```http
HTTP/1.1 200 OK

{ "accessToken": "eyJ...", "refreshToken": "eyJ...", "user": { ... } }
```

```http
POST /auth/refresh
Content-Type: application/json
X-Client-Type: mobile

{ "refreshToken": "eyJ..." }

HTTP/1.1 200 OK

{ "accessToken": "eyJ...", "refreshToken": "<novo>" }
```

`GET /me` devolve o objeto `user` na raiz, sem envelope, e não muda entre os
fluxos.

### Sair de todos os dispositivos

`POST /auth/logout-all` encerra **todas** as sessões do usuário: as do web
(todos os browsers) e as do app, inclusive a do próprio cliente que chamou. É
o "sair de todos os dispositivos" para um celular perdido ou roubado.

- Autentica pelo **access token** (`Authorization: Bearer`), não pelo refresh
  token. O corpo fica vazio; o cookie, se for junto, é ignorado.
- Exige `X-Client-Type` como as demais rotas de token. No `web`, a resposta
  também apaga o cookie deste browser (mesmo `Set-Cookie` do logout).
- Os **outros dispositivos** continuam com o access token que já tinham até
  ele expirar; no próximo `/auth/refresh` recebem 401 `Invalid refresh token`
  e vão para o login.
- O **access token atual continua válido até expirar** (é stateless, até
  `JWT_ACCESS_TTL`). Por isso o cliente deve descartá-lo e limpar o estado
  local logo após a resposta, como no logout.
- Idempotente: sem sessões abertas, responde 204 do mesmo jeito.
- Rate limit próprio: 20 req/min por IP.

```http
POST /auth/logout-all
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
X-Client-Type: web
Cookie: refreshToken=eyJhbGciOi...        ← vai junto (Path=/auth), mas é ignorado

HTTP/1.1 204 No Content
Set-Cookie: refreshToken=; Path=/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax
```

| Situação                                      | Código | `message`                             |
| --------------------------------------------- | ------ | ------------------------------------- |
| Sem Bearer, ou access token inválido/expirado | 401    | `Unauthorized`                        |
| Sem `X-Client-Type`                           | 400    | `x-client-type header is required...` |

## Erros

Todo erro sai neste formato (filtro global):

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Invalid credentials",
  "path": "/auth/login",
  "timestamp": "2026-09-21T19:26:21.843Z"
}
```

`message` é **string ou array de strings** — array nos erros de validação (400).

| Código | Quando acontece                                                                                                                                                             | O que o cliente faz                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 400    | Body inválido, campo desconhecido, `code` com tamanho ≠ 43, **`X-Client-Type` ausente/inválido**, **refresh token no canal errado**                                         | Mostra os erros de campo (`message` pode ser array)                   |
| 401    | Credenciais erradas, email inexistente, conta só-Google, access token ausente/inválido/expirado, refresh token ausente/inválido/expirado/revogado, código de troca inválido | Em request comum, tenta refresh; em `/auth/refresh`, faz logout local |
| 404    | Token válido de um usuário que foi apagado                                                                                                                                  | Limpa a sessão local                                                  |
| 409    | `POST /auth/signup` com email já cadastrado; `POST /activities/import` com arquivo já importado                                                                             | Mostra "email já em uso" (signup) ou "já importada" (importação)      |
| 429    | Rate limit por IP: 10 req/min em `/auth/login` e `/auth/signup`; 30 em `/auth/refresh` e `/auth/logout`; 20 em `/auth/google/exchange`, `/auth/logout-all` e `POST /activities/import`; 100 no resto. Também por conta, em `/auth/login` (ver abaixo) | Mostra "muitas tentativas, aguarde"; espera o `Retry-After`. Não limpa a sessão |

Casos específicos do refresh token:

| Situação                                                                                   | Código | `message`                                             |
| ------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------- |
| `web` com `refreshToken` no corpo                                                          | 400    | `must not be sent in the request body...`             |
| `mobile` com cookie `refreshToken` na request                                              | 400    | `must not be sent when X-Client-Type is mobile...`    |
| `/auth/refresh` sem token no canal certo (cookie ou corpo vazios)                          | 401    | `Missing refresh token`                               |
| `/auth/refresh` com token recusado: inválido, expirado, desconhecido, encerrado ou já usado fora da tolerância | 401    | `Invalid refresh token`                               |
| `/auth/logout` com JWT inválido ou expirado (token desconhecido: 204)                      | 401    | `Invalid refresh token`                               |
| `/auth/logout` sem token no canal certo                                                    | 204    | — (idempotente; web ainda recebe a limpeza do cookie) |

Senha errada e email inexistente retornam **o mesmo** 401 com
`"Invalid credentials"`, de propósito (não revelar quais emails existem).
Pelo mesmo motivo, todo refresh token enviado e recusado recebe o mesmo 401
`"Invalid refresh token"`, inclusive quando o backend detecta reuso e encerra
a sessão daquele cliente. O motivo fica só no log do servidor. O cliente
não tem como (nem precisa) distinguir os casos: trate como sessão encerrada.

**Limite por conta no login.** Depois de **5 falhas** de login para o mesmo
email em **15 minutos** (valores padrão do servidor), todo
`POST /auth/login` daquele email responde **429, mesmo com a senha certa**,
até os 15 minutos contados da primeira falha acabarem. Vale para qualquer
email, exista ou não a conta, e a resposta é **idêntica** à do rate limit por
IP: mesmo `statusCode`, `error`, `message`
(`ThrottlerException: Too Many Requests`) e header `Retry-After` (segundos até
liberar). O cliente não tem como (nem precisa) distinguir os dois casos. Um login
certo antes do limite zera a contagem. O bloqueio não afeta sessões já
abertas (`/auth/refresh`) nem o login com Google.

Em qualquer 429: mostre "muitas tentativas, aguarde" (sem dizer que a conta
foi bloqueada), não refaça o login automaticamente e use o `Retry-After` se
quiser exibir o tempo de espera. Um 429 em `/auth/refresh` não é sessão
encerrada: mantenha o refresh token e tente de novo depois.

## Login com Google

```
Angular → Google:  1. window.location = {API}/auth/google        (302 + cookie de state)
Google  → API:     2. GET {API}/auth/google/callback?code=...&state=...  (+ cookie de state)
API     → Angular: 3. 302 {FRONTEND_URL}/auth/callback?code=<43 chars>
                      ou 302 {FRONTEND_URL}/auth/callback?error=<código>
Angular → API:     4. POST {API}/auth/google/exchange { code }   + X-Client-Type
API     → Angular:    200 access token (+ cookie ou refresh no corpo) + user
```

1. **Navegar o browser** para `{API}/auth/google` com `window.location.href`.
   Não funciona com `HttpClient`/`fetch`: a resposta é um 302 para
   `accounts.google.com`, que bloqueia XHR cross-origin. Esta rota **não** leva
   `X-Client-Type` (navegação de browser não define headers customizados).
   A resposta seta um cookie curto de state (ver abaixo).
2. O Google chama de volta a **API** (`GOOGLE_CALLBACK_URL`, cadastrada
   idêntica no Google Console). O backend confere o `state` contra o cookie,
   troca o code com PKCE e cria ou vincula o usuário. Nenhum token é emitido
   aqui; o único `Set-Cookie` é o que apaga o cookie de state.
3. A API responde 302 para `{FRONTEND_URL}/auth/callback?code=<código>` em caso
   de sucesso, ou para `{FRONTEND_URL}/auth/callback?error=<código>` em caso de
   falha (tabela abaixo). O cliente web precisa registrar a rota
   **`/auth/callback`** tratando **os dois** query params. Nenhum token trafega
   na URL.
4. Com `code`, o componente dessa rota chama `POST /auth/google/exchange` com
   `{ "code": "..." }` **e o header `X-Client-Type`**. É aqui que o tipo de
   cliente é declarado e o cookie (web) é setado.

**Cookies de primeira parte durante o redirect.** O passo 1 seta o cookie
`googleOAuthState` (HttpOnly, `SameSite=Lax`, `Path=/auth/google`, `Secure`
conforme `COOKIE_SECURE`, 10 minutos), e o browser precisa devolvê-lo no passo 2.
Ele liga o callback ao browser que iniciou o login (proteção contra login CSRF
e injeção de `code`, com `state` + PKCE) e é apagado no callback, em qualquer
desfecho. Se o browser bloquear cookies da API, ou se o usuário levar mais de
10 minutos na tela do Google, o callback volta com `?error=state_mismatch`. O
frontend não lê nem envia esse cookie; só não pode impedir o browser de
guardá-lo. Dois logins iniciados no mesmo browser ao mesmo tempo: vale o
último, e o callback do primeiro também volta com `state_mismatch`.

### Erros do callback (`?error=`)

Toda falha do callback termina em
`302 {FRONTEND_URL}/auth/callback?error=<código>`, nunca em JSON na API. O
código é sempre um destes; nada que o Google manda (`error_description` etc.) é
repassado.

| `error`              | Quando                                                                                    | O que o frontend faz                                 |
| -------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `access_denied`      | O usuário cancelou na tela de consentimento do Google                                     | Volta para a tela de login, sem mensagem de erro     |
| `email_not_verified` | O Google não garante o email da conta (a conta não é vinculada nem criada)                | Explica que o email da conta Google não é verificado |
| `state_mismatch`     | Cookie de state ausente, expirado (> 10 min), adulterado, ou `state` divergente           | "Não foi possível concluir o login, tente de novo"   |
| `oauth_failed`       | Qualquer outra falha: `code` inválido ou expirado, outro `error=` do Google, erro interno | "Não foi possível concluir o login, tente de novo"   |

Trate qualquer outro valor de `error` como `oauth_failed`. Limpe o `error` da
URL depois de exibir a mensagem.

O código tem exatamente **43 caracteres** do alfabeto `A-Za-z0-9-_` (32 bytes em
base64url). No banco fica apenas o SHA-256 dele.

| Situação do código                | Resposta            |
| --------------------------------- | ------------------- |
| Válido                            | 200 + tokens + user |
| Já usado (uso único)              | 401                 |
| Expirado (TTL de **60 segundos**) | 401                 |
| Inexistente/adulterado, 43 chars  | 401                 |
| Tamanho diferente de 43           | 400                 |

Troque o código imediatamente ao montar o componente e **limpe o `code` da
URL** depois. Se o componente inicializar duas vezes, ou o usuário der F5 na
URL de callback, a segunda troca retorna 401 — trate como "sessão não
estabelecida, refaça o login", não como erro fatal.

Vinculação de conta (backend), sempre exigindo email **verificado pelo
Google**:

| Situação no backend                                   | Resultado                                                        | `hasPassword` |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| `googleId` já vinculado                               | Login direto                                                     | inalterado    |
| Conta local com o mesmo email, `emailVerified: true`  | Vincula; senha e sessões existentes continuam valendo            | inalterado    |
| Conta local com o mesmo email, `emailVerified: false` | Descarta a senha e **todas** as sessões da conta, depois vincula | `false`       |
| Nenhuma conta                                         | Cria conta sem senha                                             | `false`       |

O payload de resposta é o mesmo nos quatro casos.

Por que a conta não verificada perde a senha: o cadastro por email não
comprova a posse do email, então quem fez o signup pode não ser o dono (alguém
cadastra o email de outra pessoa e espera ela entrar com Google). Ao vincular,
o backend apaga numa única transação o `passwordHash`, todos os refresh tokens
e os códigos de troca pendentes da conta. Consequências para o cliente:

- Login por senha nessa conta passa a responder **401 `Invalid credentials`**;
  o usuário só entra com Google.
- Refresh tokens emitidos antes da vinculação passam a responder **401
  `Invalid refresh token`**, em qualquer dispositivo. Trate como sessão
  encerrada e mande para o login.
- Access tokens já emitidos continuam válidos até expirar (são stateless; até
  `JWT_ACCESS_TTL`, 15 minutos por padrão).
- **Ainda não existe fluxo para definir uma senha nova** (ver
  [Lacunas conhecidas](#lacunas-conhecidas)). Com `hasPassword: false`, não
  ofereça login por senha para essa conta.

## Interceptor

Quatro regras que o backend impõe, em ordem de gravidade:

1. **`/auth/refresh` é de uso único e devolve token novo.** No mobile,
   substitua o access _e_ o refresh; guardar o refresh antigo quebra a próxima
   renovação. No web isso é automático (o cookie é sobrescrito).
2. **Reapresentar um refresh token já rotacionado encerra a sessão daquele
   cliente** (o backend interpreta como roubo), exceto uma única repetição
   dentro da [janela de tolerância](#sessões-e-janela-de-tolerância). As
   sessões em outros dispositivos continuam. Garanta **um único refresh em
   voo**, com as demais requests em fila: a tolerância é para a resposta
   perdida, não para refreshes paralelos.
3. **Não intercepte as rotas de auth.** Um 401 de `/auth/login` ou
   `/auth/refresh` não deve disparar refresh — gera laço infinito.
4. **Todas as chamadas precisam de `X-Client-Type`** (e, no web, de
   `withCredentials: true`). Sem isso, 400 em vez do erro que você espera.

```ts
// Angular (fluxo web). Um refresh em voo, requests em fila, retry uma vez.
let refreshing: Observable<{ accessToken: string }> | null = null;

intercept(req: HttpRequest<unknown>, next: HttpHandler) {
  // withCredentials + header em toda chamada: o cookie do refresh token só
  // acompanha /auth/*, mas o header é exigido nas rotas de token.
  const authed = req.clone({
    withCredentials: true,
    setHeaders: {
      'X-Client-Type': 'web',
      ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}),
    },
  });

  if (req.url.includes('/auth/')) return next.handle(authed);   // regra 3

  return next.handle(authed).pipe(
    catchError(err => {
      if (err.status !== 401) return throwError(() => err);

      // Corpo vazio: o refresh token vai no cookie httpOnly (regra: nunca no
      // corpo para web, senão 400).
      refreshing ??= http.post<{ accessToken: string }>('/auth/refresh', {}, {
        withCredentials: true,
        headers: { 'X-Client-Type': 'web' },
      }).pipe(
        // Erro de rede (status 0): a renovação pode ter acontecido e a resposta
        // se perdido. O cookie não foi sobrescrito, então repetir UMA vez, logo,
        // cai na janela de tolerância e devolve um par válido.
        retry({ count: 1, delay: e => (e.status === 0 ? timer(300) : throwError(() => e)) }),
        tap(({ accessToken }) => tokens.setAccess(accessToken)),
        catchError(e => {
          // Só o 401 encerra a sessão local. Em erro de rede, mantém o estado.
          if (e.status === 401) { tokens.clear(); router.navigate(['/login']); }
          return throwError(() => e);
        }),
        finalize(() => { refreshing = null; }),
        shareReplay(1),                                // regra 2: um só em voo
      );

      return refreshing.pipe(
        switchMap(({ accessToken }) =>
          next.handle(authed.clone({ setHeaders: { Authorization: `Bearer ${accessToken}` } })),
        ),
      );
    }),
  );
}
```

No mobile é o mesmo esqueleto, com duas diferenças: `X-Client-Type: mobile`,
e o refresh manda/recebe o token no corpo (`{ refreshToken }` → salvar o novo).
Em erro de rede, mantenha o refresh token enviado (não há outro: o novo, se
existiu, não chegou) e repita uma vez com ele. No Android, o equivalente é um
`Authenticator`/`Interceptor` do OkHttp, com a mesma regra de um único refresh
em voo; o passo a passo está em
[AUTH-CONTRACT-MOBILE.md](AUTH-CONTRACT-MOBILE.md#erro-de-rede-no-refresh).

Na inicialização do app: chame `/auth/refresh` **antes** de renderizar rotas
protegidas (web: basta o cookie; mobile: se houver token salvo) e trate 401
como "sessão expirada". Erro de rede ali segue a mesma regra: não limpa a
sessão e pode ser repetido uma vez com o mesmo token.

No logout, chame `POST /auth/logout` e limpe o estado local. O access token
continua tecnicamente válido até expirar (é stateless), por isso descartá-lo no
cliente é obrigatório. O mesmo vale para `POST /auth/logout-all` ("sair de
todos os dispositivos", ver [acima](#sair-de-todos-os-dispositivos)).

## CSRF (fluxo web)

`SameSite=Lax` + header obrigatório `X-Client-Type` + CORS de origem única são
suficientes; **não há token CSRF** e nenhum é necessário hoje:

- Só `/auth/refresh` e `/auth/logout` autenticam por cookie; o resto da API
  (inclusive `/auth/logout-all`) usa `Authorization: Bearer`, imune a CSRF.
- `Lax` impede o cookie de ir em POST cross-site (o vetor clássico).
- Um header customizado não pode ser definido por form HTML e, via JS, força
  preflight CORS — que só `FRONTEND_URL` passa.
- Mesmo uma request forjada não teria a resposta lida (CORS), então não haveria
  roubo de token.

**Atenção ao deploy:** se frontend e API ficarem em sites registráveis
diferentes (ex. `app.vercel.app` → `api.onrender.com`), o cookie `Lax` não é
enviado pelo XHR e o fluxo web quebra. Nesse cenário seria necessário
`SameSite=None; Secure` **mais** um token CSRF (double-submit). Com
`dutrail.com` + `api.dutrail.com` (mesmo site) o `Lax` funciona; em dev,
`localhost:4200` → `localhost:3000` também.

## Lacunas conhecidas

Não implementadas nesta etapa — o cliente não deve contar com elas:

- **Verificação de email e reset de senha** (dependem de envio de email).
- **Login nativo com Google no Android** (`POST /auth/google/token`
  recebendo o `idToken`). Hoje só existe o fluxo de redirect.
- **Definição de senha para conta sem senha** (`hasPassword: false`): contas
  criadas via Google e contas locais não verificadas que perderam a senha ao
  serem vinculadas ao Google.
- **Alteração de perfil** (nome, avatar). `GET /me` é somente leitura.
- **`SameSite=None` configurável por ambiente**: hoje `Lax` é fixo no código
  (`RefreshTokenTransport.cookieOptions`).
