# Contrato da API de Autenticação — Dutrail

Referência para quem consome esta API (frontend Angular e, futuramente, o app
React Native). Espelha o comportamento verificado pelos testes em
[`test/auth.e2e-spec.ts`](../test/auth.e2e-spec.ts), que rodam os mesmos
cenários para os dois tipos de cliente; a documentação interativa fica em
`/docs` e o OpenAPI JSON em `/docs-json`.

O **access token** sempre vai no corpo JSON e volta em
`Authorization: Bearer <accessToken>`. O **refresh token** tem dois transportes,
escolhidos pelo header obrigatório `X-Client-Type`:

| `X-Client-Type` | Refresh token trafega em             | Cliente                  |
| --------------- | ------------------------------------ | ------------------------ |
| `web`           | Cookie `httpOnly` (o cliente não vê) | Angular                  |
| `mobile`        | Corpo JSON                           | React Native (e cURL/CI) |

Base em desenvolvimento: `http://localhost:3000`; CORS liberado apenas para a
origem em `FRONTEND_URL` (`http://localhost:4200`), com `credentials: true`.

## X-Client-Type é obrigatório

Nas rotas que emitem ou leem o refresh token (`/auth/signup`, `/auth/login`,
`/auth/refresh`, `/auth/logout`, `/auth/google/exchange`):

| Header                             | Resposta                                               |
| ---------------------------------- | ------------------------------------------------------ |
| `X-Client-Type: web` ou `mobile`   | Fluxo normal (case-insensitive, espaços são ignorados) |
| Ausente                            | **400** `x-client-type header is required...`          |
| Valor desconhecido (ex. `desktop`) | **400** `x-client-type header must be one of...`       |

Não há default silencioso. `GET /auth/google`, `GET /auth/google/callback` e
`GET /me` **não** aceitam nem exigem o header (as duas primeiras são navegação
de browser, que não permite headers customizados).

## Os dois fluxos lado a lado

|                                | `web`                                                                                           | `mobile`                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Configuração do cliente        | `withCredentials: true` em todas as chamadas                                                    | Nada (sem cookies)                       |
| Corpo de signup/login/exchange | `{ accessToken, user }`                                                                         | `{ accessToken, refreshToken, user }`    |
| Corpo de `/auth/refresh`       | `{ accessToken }`                                                                               | `{ accessToken, refreshToken }`          |
| `Set-Cookie` na resposta       | `refreshToken=...; Max-Age=604800; Path=/auth; HttpOnly; SameSite=Lax` (+ `Secure` em produção) | nunca                                    |
| Enviar o refresh token         | Automático (cookie); corpo deve ficar **vazio**                                                 | `{ "refreshToken": "eyJ..." }` no corpo  |
| Token no canal errado          | Corpo preenchido → **400**                                                                      | Cookie `refreshToken` presente → **400** |
| Logout                         | Revoga no banco + apaga o cookie (`Set-Cookie: refreshToken=; Expires=1970`)                    | Revoga no banco                          |
| Onde o cliente guarda          | Em nenhum lugar — o cookie é `httpOnly`                                                         | Storage seguro do SO (Keychain/Keystore) |

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

`hasPassword: false` identifica conta criada via Google que nunca definiu senha.

## Endpoints

| Método | Rota                    | `X-Client-Type` | Corpo enviado                         | Sucesso | Resposta                              |
| ------ | ----------------------- | --------------- | ------------------------------------- | ------- | ------------------------------------- |
| POST   | `/auth/signup`          | obrigatório     | `email`, `password`, `name?`          | 201     | access (+ refresh se mobile) + `user` |
| POST   | `/auth/login`           | obrigatório     | `email`, `password`                   | 200     | access (+ refresh se mobile) + `user` |
| POST   | `/auth/refresh`         | obrigatório     | vazio (web) / `refreshToken` (mobile) | 200     | access (+ refresh se mobile)          |
| POST   | `/auth/logout`          | obrigatório     | vazio (web) / `refreshToken` (mobile) | 204     | corpo vazio                           |
| GET    | `/auth/google`          | —               | —                                     | 302     | redirect para o Google                |
| POST   | `/auth/google/exchange` | obrigatório     | `code`                                | 200     | access (+ refresh se mobile) + `user` |
| GET    | `/me`                   | —               | — (Bearer)                            | 200     | apenas `user`                         |

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
Set-Cookie: refreshToken=eyJhbGciOi...; Max-Age=604800; Path=/auth; HttpOnly; SameSite=Lax

{ "accessToken": "eyJhbGciOiJIUzI1NiJ9...", "user": { ... } }
```

```http
POST /auth/refresh
X-Client-Type: web
Cookie: refreshToken=eyJhbGciOi...        ← o browser envia sozinho

HTTP/1.1 200 OK
Set-Cookie: refreshToken=<novo>; Max-Age=604800; Path=/auth; HttpOnly; SameSite=Lax

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
| 409    | `POST /auth/signup` com email já cadastrado                                                                                                                                 | Mostra "email já em uso" no formulário                                |
| 429    | Rate limit: 10 req/min por IP em `/auth/login` e `/auth/signup`; 100 req/min no resto                                                                                       | Mostra "muitas tentativas, aguarde"                                   |

Casos específicos do transporte:

| Situação                                                          | Código | `message`                                             |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| `web` com `refreshToken` no corpo                                 | 400    | `must not be sent in the request body...`             |
| `mobile` com cookie `refreshToken` na request                     | 400    | `must not be sent when X-Client-Type is mobile...`    |
| `/auth/refresh` sem token no canal certo (cookie ou corpo vazios) | 401    | `Missing refresh token`                               |
| `/auth/logout` sem token no canal certo                           | 204    | — (idempotente; web ainda recebe a limpeza do cookie) |

Senha errada e email inexistente retornam **o mesmo** 401 com
`"Invalid credentials"`, de propósito (não revelar quais emails existem).

## Login com Google

```
Angular → Google:  1. window.location = {API}/auth/google        (302)
Google  → API:     2. GET {API}/auth/google/callback?code=...
API     → Angular: 3. 302 {FRONTEND_URL}/auth/callback?code=<43 chars>
Angular → API:     4. POST {API}/auth/google/exchange { code }   + X-Client-Type
API     → Angular:    200 access token (+ cookie ou refresh no corpo) + user
```

1. **Navegar o browser** para `{API}/auth/google` com `window.location.href`.
   Não funciona com `HttpClient`/`fetch`: a resposta é um 302 para
   `accounts.google.com`, que bloqueia XHR cross-origin. Esta rota **não** leva
   `X-Client-Type` (navegação de browser não define headers customizados).
2. O Google chama de volta a **API** (`GOOGLE_CALLBACK_URL`, cadastrada
   idêntica no Google Console). O backend cria ou vincula o usuário. Nenhum
   token e nenhum cookie são emitidos aqui.
3. A API responde 302 para `{FRONTEND_URL}/auth/callback?code=<código>`. O
   cliente web precisa registrar a rota **`/auth/callback`** lendo o query
   param `code`. Nenhum token trafega na URL.
4. O componente dessa rota chama `POST /auth/google/exchange` com
   `{ "code": "..." }` **e o header `X-Client-Type`** — é aqui que o tipo de
   cliente é declarado e o cookie (web) é setado.

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

Vinculação de conta (backend): `googleId` existente → login direto; mesmo email
**verificado pelo Google** → vincula e a senha antiga continua valendo
(`hasPassword: true`); nada encontrado → cria conta sem senha
(`hasPassword: false`). O payload de resposta é o mesmo nos três casos.

## Interceptor

Quatro regras que o backend impõe, em ordem de gravidade:

1. **`/auth/refresh` é de uso único e devolve token novo.** No mobile,
   substitua o access _e_ o refresh; guardar o refresh antigo quebra a próxima
   renovação. No web isso é automático (o cookie é sobrescrito).
2. **Reapresentar um refresh token já rotacionado revoga todas as sessões do
   usuário** (o backend interpreta como roubo). Garanta **um único refresh em
   voo**, com as demais requests em fila.
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
        tap(({ accessToken }) => tokens.setAccess(accessToken)),
        catchError(e => { tokens.clear(); router.navigate(['/login']); return throwError(() => e); }),
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

Na inicialização do app: chame `/auth/refresh` **antes** de renderizar rotas
protegidas (web: basta o cookie; mobile: se houver token salvo) e trate 401
como "sessão expirada".

No logout, chame `POST /auth/logout` e limpe o estado local. O access token
continua tecnicamente válido até expirar (é stateless), por isso descartá-lo no
cliente é obrigatório.

## CSRF (fluxo web)

`SameSite=Lax` + header obrigatório `X-Client-Type` + CORS de origem única são
suficientes; **não há token CSRF** e nenhum é necessário hoje:

- Só `/auth/refresh` e `/auth/logout` autenticam por cookie; o resto da API usa
  `Authorization: Bearer`, imune a CSRF.
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

- **Cancelamento no consentimento do Google**: o Passport responde 401 em JSON
  na URL da API em vez de redirecionar para o frontend. Correção prevista:
  redirecionar para `{FRONTEND_URL}/auth/callback?error=access_denied`.
- **Verificação de email e reset de senha** (dependem de envio de email).
- **Login nativo com Google no React Native** (`POST /auth/google/token`
  recebendo o `idToken`). Hoje só existe o fluxo de redirect.
- **Definição de senha para conta criada via Google** (`hasPassword: false`).
- **Alteração de perfil** (nome, avatar). `GET /me` é somente leitura.
- **`SameSite=None` configurável por ambiente**: hoje `Lax` é fixo no código
  (`RefreshTokenTransport.cookieOptions`).
