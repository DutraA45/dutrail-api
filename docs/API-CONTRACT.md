# Contrato da API de Autenticação — Dutrail

Referência do cliente **web (Angular)** para autenticação e para os padrões
comuns a toda a API (Bearer, formato de erro, rate limit, refresh no 401).
Documentos complementares:

- [`ACTIVITIES-CONTRACT.md`](ACTIVITIES-CONTRACT.md): rotas `/activities`.
  Seguem os padrões descritos aqui.
- [`AUTH-CONTRACT-MOBILE.md`](AUTH-CONTRACT-MOBILE.md): o mesmo contrato do
  ponto de vista do app Android (`X-Client-Type: mobile`). Autossuficiente; o
  cliente web não precisa dele.

Conferido contra o código e contra requisições reais (app em `development`,
banco descartável) em 2026-10-05. Os exemplos de resposta abaixo saíram
dessas requisições, com os tokens truncados em `…`.

> **Resumo para quem implementa o cliente**
>
> 1. Toda request para `/auth/*` leva `X-Client-Type: web` e `withCredentials: true`; sem o header, 400.
> 2. O refresh token do web vive só no cookie `httpOnly`: o JS nunca o lê, guarda nem envia no corpo (corpo com `refreshToken` = 400).
> 3. O access token fica só em memória e vai em `Authorization: Bearer`. Não o decodifique.
> 4. Um único `/auth/refresh` em voo; as outras requests esperam por ele. Três ou mais refreshes simultâneos com o mesmo cookie encerram a sessão.
> 5. 401 numa rota com Bearer (inclusive `/auth/logout-all`): refresh e repete uma vez. 401 no próprio `/auth/refresh`: sessão encerrada, vai para o login.
> 6. Erro de rede no refresh: não desloga; repete uma vez, logo em seguida. 429 e 5xx no refresh também não deslogam.
> 7. 429: "muitas tentativas, aguarde"; o browser não expõe o `Retry-After` ao JS.
> 8. 400: `message` pode ser string ou array. Decida pelo `statusCode` e pela rota, nunca pelo texto.
> 9. Não fixe TTLs nem limites no código: são padrões configuráveis do servidor.
> 10. Login com Google: navegue com `window.location`, trate `?code=` e `?error=` em `/auth/callback`, troque o `code` uma vez só.

## Visão geral

- **Access token**: JWT curto, devolvido no corpo JSON (`accessToken`) e
  enviado em `Authorization: Bearer <accessToken>`. É opaco para o cliente
  (ver [O que o cliente não deve assumir](#o-que-o-cliente-não-deve-assumir)).
  Os dados do usuário vêm do objeto `user` das respostas ou de `GET /me`.
- **Refresh token**: JWT longo, de uso único (cada renovação devolve outro).
  O transporte depende do header `X-Client-Type`:

| `X-Client-Type` | Refresh token trafega em             | Cliente                     |
| --------------- | ------------------------------------ | --------------------------- |
| `web`           | Cookie `httpOnly` (o JS não o vê)    | Angular                     |
| `mobile`        | Corpo JSON                           | App Android (e cURL/testes) |

Rotação, detecção de reuso e revogação são idênticas nos dois; só o
transporte muda. O servidor guarda apenas o SHA-256 dos tokens.

Base em desenvolvimento: `http://localhost:3000`. O CORS libera só a origem
configurada em `FRONTEND_URL` (em desenvolvimento, `http://localhost:4200`),
com `credentials: true`, e aceita os headers `X-Client-Type`, `Content-Type`
e `Authorization` no preflight. A URL base de produção não faz parte deste
documento.

**Swagger.** `/docs` (UI) e `/docs-json` (OpenAPI) existem só com `NODE_ENV`
diferente de `production`. Em produção respondem 404, e a referência é este
documento. Não há snapshot do OpenAPI versionado: o gerado hoje tem
divergências de tipo (por exemplo, `user.name` e `user.avatarUrl` aparecem
como `object`; o certo é `string | null`). Se gerar tipos a partir do
`/docs-json` de desenvolvimento, confira-os contra este documento.

## `X-Client-Type` por rota

Valores aceitos: `web` ou `mobile`, sem diferenciar maiúsculas e ignorando
espaços nas pontas. Não há default.

| Rota                                                                                         | `X-Client-Type`            | Sem o header ou com valor desconhecido |
| -------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------- |
| `POST /auth/signup`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/google/exchange` | obrigatório                | **400**                                |
| `POST /auth/logout-all`                                                                      | obrigatório (além do Bearer) | **400** (com Bearer válido; sem Bearer, 401 antes) |
| `GET /auth/google`, `GET /auth/google/callback`                                              | ignorado                   | segue normalmente                      |
| `GET /me`, rotas `/activities`                                                               | ignorado                   | segue normalmente                      |

Como o header é ignorado onde não é usado, o interceptor pode mandá-lo em
toda request. Mensagens (sempre string):

- ausente: `x-client-type header is required (expected one of: web, mobile)`;
- valor desconhecido: `x-client-type header must be one of: web, mobile`.

O header é conferido antes do corpo: uma request sem o header e com o corpo
inválido recebe o 400 do header.

## Endpoints

| Método | Rota                    | Autenticação  | Corpo enviado (web)          | Sucesso | Corpo da resposta (web)     | Limite por IP |
| ------ | ----------------------- | ------------- | ---------------------------- | ------- | --------------------------- | ------------- |
| POST   | `/auth/signup`          | —             | `email`, `password`, `name?` | 201     | `{ accessToken, user }`     | 10/min        |
| POST   | `/auth/login`           | —             | `email`, `password`          | 200     | `{ accessToken, user }`     | 10/min        |
| POST   | `/auth/refresh`         | cookie        | vazio (ou `{}`)              | 200     | `{ accessToken }`           | 30/min        |
| POST   | `/auth/logout`          | cookie        | vazio (ou `{}`)              | 204     | vazio                       | 30/min        |
| POST   | `/auth/logout-all`      | Bearer        | vazio (ignorado)             | 204     | vazio                       | 20/min        |
| GET    | `/auth/google`          | —             | — (navegação)                | 302     | redirect para o Google      | 100/min       |
| GET    | `/auth/google/callback` | —             | — (chamado pelo Google)      | 302     | redirect para o frontend    | 100/min       |
| POST   | `/auth/google/exchange` | —             | `code`                       | 200     | `{ accessToken, user }`     | 20/min        |
| GET    | `/me`                   | Bearer        | —                            | 200     | `user` na raiz              | 100/min       |

Em `signup`, `login`, `refresh` e `google/exchange` com `web`, o refresh
token vai no `Set-Cookie` (ver [Cookie do refresh token](#cookie-do-refresh-token)).
Com `mobile`, o corpo também traz `refreshToken` e não há `Set-Cookie`.

Os limites são por IP e **por rota** (cada rota tem o seu contador). Os
valores são os atuais do servidor e podem mudar; ver [Rate limit](#rate-limit).

## O objeto `user`

Igual em todas as respostas (`signup`, `login`, `google/exchange` e `GET /me`,
este último na raiz e sem envelope):

```json
{
  "id": "97a04ba6-f834-4e32-a0f6-d1c28b37fde4",
  "email": "ana@example.com",
  "name": "Ana",
  "avatarUrl": null,
  "emailVerified": false,
  "hasPassword": true,
  "createdAt": "2026-10-05T20:58:54.675Z"
}
```

| Campo           | Tipo JSON         | Nulo? | Significado                                                                          |
| --------------- | ----------------- | ----- | ------------------------------------------------------------------------------------ |
| `id`            | string (UUID)     | não   | Identificador do usuário                                                             |
| `email`         | string            | não   | Email normalizado (sem espaços nas pontas, minúsculo)                                |
| `name`          | string            | sim   | Nome. `null` se não informado no cadastro                                            |
| `avatarUrl`     | string (URL)      | sim   | Foto (hoje só vem do Google)                                                         |
| `emailVerified` | boolean           | não   | `true` só para contas criadas ou vinculadas pelo Google                              |
| `hasPassword`   | boolean           | não   | `false` para conta sem senha (ver [Login com Google](#login-com-google))             |
| `createdAt`     | string (ISO 8601) | não   | Criação da conta                                                                     |

Os campos nulos vêm como `null`, nunca omitidos. Nenhuma resposta contém
senha, hash de senha ou `googleId`.

## Cadastro e login

Validação (o servidor rejeita campos desconhecidos com 400; não são
ignorados):

| Campo      | `POST /auth/signup`                                    | `POST /auth/login`             |
| ---------- | ------------------------------------------------------ | ------------------------------ |
| `email`    | obrigatório, email válido; o servidor tira espaços e põe em minúsculas | idem               |
| `password` | obrigatório, 8 a 128 caracteres                        | obrigatório, 1 a 128 caracteres |
| `name`     | opcional, até 100 caracteres (espaços nas pontas removidos) | não aceito (400)          |

**Normalização NFKC.** A senha é normalizada em NFKC no servidor, no cadastro
e no login: formas Unicode equivalentes entram igual ("é" pré-composto ou
"e" + acento combinante; "ｐａｓｓ" de largura total ou "pass"). Envie a senha
como foi digitada, sem normalizar no cliente. O limite de 128 vale também
depois da normalização, que pode aumentar o texto (ex.: "㍿" vira 4
caracteres); se passar, o cadastro responde 400.

**Senha vazada.** No cadastro, a senha é conferida numa base de senhas
vazadas (Have I Been Pwned). Se constar, 400 e o formulário deve pedir outra
senha. Se a base estiver indisponível, o cadastro segue. O login não faz essa
checagem.

**Ordem das checagens do cadastro:** validação dos campos (400), limite de
128 depois do NFKC (400), email já cadastrado (409), senha vazada (400). Um
email já cadastrado recebe 409 mesmo com uma senha vazada.

### Exemplos

```http
POST /auth/login
Content-Type: application/json
X-Client-Type: web

{ "email": "ana@example.com", "password": "S3nh@Forte!" }
```

```http
HTTP/1.1 200 OK
Set-Cookie: refreshToken=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…; Max-Age=604799; Path=/auth; Expires=Mon, 12 Oct 2026 20:58:55 GMT; HttpOnly; Secure; SameSite=Lax
Content-Type: application/json; charset=utf-8

{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": {
    "id": "97a04ba6-f834-4e32-a0f6-d1c28b37fde4",
    "email": "ana@example.com",
    "name": "Ana",
    "avatarUrl": null,
    "emailVerified": false,
    "hasPassword": true,
    "createdAt": "2026-10-05T20:58:54.675Z"
  }
}
```

`POST /auth/signup` responde no mesmo formato, com status 201.

```http
POST /auth/refresh
X-Client-Type: web
Cookie: refreshToken=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…     ← o browser envia sozinho

HTTP/1.1 200 OK
Set-Cookie: refreshToken=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…; Max-Age=604798; Path=/auth; Expires=Mon, 12 Oct 2026 20:58:56 GMT; HttpOnly; Secure; SameSite=Lax

{ "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" }
```

Com `X-Client-Type: mobile`, as mesmas rotas devolvem também
`"refreshToken"` no corpo e nenhum `Set-Cookie`; o detalhe está em
[`AUTH-CONTRACT-MOBILE.md`](AUTH-CONTRACT-MOBILE.md).

## Cookie do refresh token

| Atributo   | Valor                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Nome       | `refreshToken`                                                                                          |
| `HttpOnly` | sempre                                                                                                  |
| `SameSite` | `Lax`                                                                                                   |
| `Path`     | `/auth` (o browser só o envia para `/auth/*`)                                                           |
| `Domain`   | nenhum (cookie do host da API)                                                                          |
| `Secure`   | presente por padrão, em qualquer ambiente; ver abaixo                                                   |
| `Max-Age`  | segundos que faltam até o `exp` do refresh token emitido (e `Expires` com a mesma data)                 |

- **`Max-Age` derivado da validade real.** Acompanha o `JWT_REFRESH_TTL` do
  servidor e é renovado a cada `/auth/refresh`. Com o padrão de 7 dias sai
  `Max-Age=604799` ou `604798` (um pouco abaixo de 604800, pelo tempo até a
  resposta). Não é um valor fixo.
- **`Secure`.** O browser só envia o cookie por HTTPS (Chrome e Firefox
  também o aceitam em `http://localhost`). O servidor omite a flag apenas com
  `COOKIE_SECURE=false`, opção para desenvolvimento local em `http://` com
  Safari, que recusa cookie `Secure` fora de HTTPS. Em produção o servidor não
  sobe com `COOKIE_SECURE=false`.
- **Limpeza.** `POST /auth/logout` e `POST /auth/logout-all` com `web`
  respondem com
  `Set-Cookie: refreshToken=; Path=/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`.
- **Canal errado.** No web, o refresh token só é lido do cookie. Enviar
  `refreshToken` no corpo de `/auth/refresh` ou `/auth/logout` é 400, mesmo
  junto com o cookie. Corpo vazio ou `{}` é o correto.

## Validade dos tokens e sessões

Padrões **configuráveis** no servidor. Não são garantia e podem mudar por
ambiente; o cliente não deve fixá-los.

| Item                                          | Variável                | Padrão                               |
| --------------------------------------------- | ----------------------- | ------------------------------------ |
| Access token                                  | `JWT_ACCESS_TTL`        | 15 minutos (máximo 1 hora)           |
| Refresh token                                 | `JWT_REFRESH_TTL`       | 7 dias (máximo 30 dias)              |
| Janela de tolerância do refresh já usado      | `REFRESH_GRACE_SECONDS` | 30 segundos (máximo 60; 0 desativa)  |
| Código de troca do Google                     | fixo no código          | 60 segundos, uso único               |

**Janela deslizante.** Cada `/auth/refresh` bem-sucedido emite um refresh
token novo com a validade completa, contada a partir dali. Não há duração
máxima de sessão: ela termina se o cliente passar um `JWT_REFRESH_TTL` inteiro
sem renovar, ou se for encerrada (logout, logout de todos os dispositivos,
reuso detectado naquela sessão, ou vinculação ao Google de conta não
verificada). O cliente não precisa agendar renovação: renova ao receber 401
(ver [Interceptor](#interceptor)).

### Sessões e janela de tolerância

Cada login (senha, cadastro ou Google) abre uma **sessão** própria daquele
browser ou aparelho. Os refresh tokens que saem das renovações dela
pertencem à mesma sessão.

Um refresh token que acabou de ser trocado ainda pode ser reapresentado **uma
única vez**, por até `REFRESH_GRACE_SECONDS` (30 s no padrão) depois da troca,
desde que o token que o substituiu ainda não tenha sido usado. Essa repetição
recebe um par novo e válido da mesma sessão. Cobre:

- **resposta perdida**: o servidor renovou, mas a resposta não chegou. O
  cookie não foi sobrescrito, então repetir o refresh com ele cai na janela;
- **duas abas** renovando ao mesmo tempo com o mesmo cookie: as duas recebem
  um par válido.

Fora disso, reapresentar um refresh token já usado é **reuso**: o servidor
encerra **a sessão daquele browser** (todos os tokens dela) e responde 401
`Invalid refresh token`. As outras sessões do usuário (outros browsers, o
app) continuam. Contam como reuso: repetir depois da janela, repetir pela
segunda vez o mesmo token e repetir um token cujo substituto já foi usado.
Três ou mais abas renovando ao mesmo tempo esgotam a tolerância e encerram a
sessão do browser; se o app abrir muitas abas, serialize o refresh entre elas
(por exemplo, `navigator.locks.request('refresh', ...)`).

## Logout e logout de todos os dispositivos

**`POST /auth/logout`** encerra a sessão deste browser: apaga o refresh token
do cookie no servidor e responde 204 com o `Set-Cookie` de limpeza. É
idempotente: sem cookie, ou com um token que já não existe, também responde
204 (e limpa o cookie). Só um cookie com JWT inválido, adulterado ou expirado
recebe 401 `Invalid refresh token`; mesmo assim, limpe o estado local.

**`POST /auth/logout-all`** encerra **todas** as sessões do usuário: todos os
browsers, o app e a própria sessão de quem chamou. Uso típico: celular
perdido.

- Autentica pelo **Bearer**, não pelo cookie. O corpo é ignorado.
- Exige `X-Client-Type`. Com `web`, a resposta também limpa o cookie deste
  browser.
- Idempotente: sem sessões abertas, 204 do mesmo jeito.
- Também invalida códigos de troca do Google ainda não usados.

```http
POST /auth/logout-all
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
X-Client-Type: web

HTTP/1.1 204 No Content
Set-Cookie: refreshToken=; Path=/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax
```

Nos dois casos, **o access token continua válido até expirar** (é stateless,
até `JWT_ACCESS_TTL`). O cliente deve descartá-lo e limpar o estado local
logo depois da resposta. Depois de um logout-all, os outros dispositivos
continuam com o access token que já tinham até ele expirar, e no próximo
`/auth/refresh` recebem 401 `Invalid refresh token`.

## Login com Google

```
Angular → API:     1. window.location.href = {API}/auth/google        (302 para o Google + cookie de state)
Google  → API:     2. GET {API}/auth/google/callback?code=...&state=...  (o browser devolve o cookie de state)
API     → Angular: 3. 302 {FRONTEND_URL}/auth/callback?code=<43 caracteres>
                      ou 302 {FRONTEND_URL}/auth/callback?error=<código>
Angular → API:     4. POST {API}/auth/google/exchange { "code": "..." }  + X-Client-Type: web
API     → Angular:    200 { accessToken, user } + Set-Cookie do refresh token
```

1. **Navegue o browser** para `{API}/auth/google` (`window.location.href`).
   `HttpClient`/`fetch` não funcionam: a resposta é um 302 para
   `accounts.google.com`. Esta rota não usa `X-Client-Type`.
2. O Google chama de volta a **API**. O servidor confere o `state`, troca o
   code com o Google (PKCE) e cria ou vincula o usuário. Nenhum token é
   emitido aqui.
3. A API redireciona para `{FRONTEND_URL}/auth/callback` com `code` (sucesso)
   ou `error` (falha), nunca os dois. Registre a rota **`/auth/callback`** no
   Angular tratando os dois query params. Nenhum token trafega na URL.
4. Com `code`, chame `POST /auth/google/exchange` com `{ "code": "..." }` e
   `X-Client-Type: web`. A resposta é igual à do login (200, `accessToken` +
   `user`, cookie do refresh token).

**Cookie de state.** O passo 1 seta
`googleOAuthState=<valor assinado>; Max-Age=600; Path=/auth/google; Expires=...; HttpOnly; Secure; SameSite=Lax`
(o `Secure` segue a mesma regra do cookie do refresh token). O browser o
devolve no passo 2, e o servidor o apaga no callback, em qualquer desfecho.
**O cliente não lê, não envia e não apaga esse cookie**; só não pode impedir
o browser de guardá-lo. Se o browser bloquear cookies da API, ou se o usuário
levar mais de 10 minutos na tela do Google, o callback volta com
`?error=state_mismatch`. Dois logins iniciados no mesmo browser ao mesmo
tempo: vale o último, e o primeiro volta com `state_mismatch`.

### Erros do callback (`?error=`)

Toda falha do callback termina em `302 {FRONTEND_URL}/auth/callback?error=<código>`,
nunca em JSON na API (a única exceção é o 429 do rate limit, que sai em JSON
no domínio da API). Nada que o Google manda (`error_description` etc.) é
repassado.

| `error`              | Quando                                                                                     | O que o frontend faz                                 |
| -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `access_denied`      | O usuário cancelou na tela de consentimento                                                | Volta para a tela de login, sem mensagem de erro     |
| `email_not_verified` | O Google não garante o email da conta; nenhuma conta é criada ou vinculada                 | Explica que o email da conta Google não é verificado |
| `state_mismatch`     | Cookie de state ausente, expirado (mais de 10 min), adulterado, ou `state` divergente      | "Não foi possível concluir o login, tente de novo"   |
| `oauth_failed`       | Qualquer outra falha: `code` inválido, outro `error=` do Google, callback sem parâmetros, erro interno | "Não foi possível concluir o login, tente de novo" |

Trate qualquer outro valor de `error` como `oauth_failed`. Depois de usar,
limpe `code` e `error` da URL (por exemplo, `router.navigate` com
`replaceUrl: true`).

### Troca do código

O `code` tem exatamente **43 caracteres** de `A-Z a-z 0-9 - _`.

| Situação                                    | Resposta                                                           |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Válido                                      | 200 + `accessToken` + `user` (+ cookie)                            |
| Já usado, expirado (60 s) ou inexistente    | 401 `Invalid or expired code`                                      |
| Duas trocas simultâneas do mesmo código     | uma 200 e uma 401 `Invalid or expired code`                        |
| Tamanho diferente de 43                     | 400 `["code must be longer than or equal to 43 characters"]` (ou `shorter than or equal to`) |

Troque o código assim que o componente montar, uma vez só. Se o componente
inicializar duas vezes ou o usuário der F5 na URL de callback, a segunda
troca recebe 401: trate como "login não concluído, tente de novo", não como
erro fatal.

### Vinculação de conta

O servidor só cria ou vincula conta quando o Google garante o email.

| Situação no servidor                                  | Resultado                                                                              | `hasPassword` |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------- |
| Conta Google já vinculada                             | Login direto                                                                           | inalterado    |
| Conta local com o mesmo email, `emailVerified: true`  | Vincula. Senha e sessões continuam valendo. `name`/`avatarUrl` só são preenchidos se estavam vazios | inalterado (`true`) |
| Conta local com o mesmo email, `emailVerified: false` | Apaga a senha e **todas** as sessões da conta, depois vincula                          | `false`       |
| Nenhuma conta                                         | Cria conta sem senha, com `emailVerified: true`                                        | `false`       |

Por que a conta não verificada perde a senha: o cadastro por email não prova
que quem cadastrou é o dono do email. Quando o dono entra pelo Google, tudo
o que veio antes é descartado. Consequências para o cliente:

- O login por senha nessa conta passa a responder **401 `Invalid credentials`**.
  Com `hasPassword: false`, não ofereça login por senha nem troca de senha.
- Os refresh tokens anteriores, em qualquer dispositivo, recebem **401
  `Invalid refresh token`** no próximo refresh: sessão encerrada, vai para o
  login.
- Os access tokens já emitidos valem até expirar.
- Ainda não existe fluxo para definir uma senha nova (ver
  [Lacunas conhecidas](#lacunas-conhecidas)).

O app Android ainda não consegue concluir este fluxo (o callback sempre
redireciona para `FRONTEND_URL`), e o login nativo com Google não existe; ver
[`AUTH-CONTRACT-MOBILE.md`](AUTH-CONTRACT-MOBILE.md#login-com-google).

## Erros

Todo erro sai neste formato (filtro global), exceto os redirects do callback
do Google:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Email already registered",
  "path": "/auth/signup",
  "timestamp": "2026-10-05T20:58:55.230Z"
}
```

| Campo        | Tipo                     | Observação                                                                 |
| ------------ | ------------------------ | -------------------------------------------------------------------------- |
| `statusCode` | número                   | Igual ao status HTTP. É o que o cliente usa para decidir                   |
| `error`      | string                   | Nome do status (`Bad Request`, `Unauthorized`, `Too Many Requests`...)     |
| `message`    | string **ou** array de strings | Array nos erros de validação de campos; string nos demais           |
| `path`       | string                   | Caminho da request, **com a query string** se houver                       |
| `timestamp`  | string (ISO 8601)        | Momento do erro                                                            |

As mensagens de auth estão em inglês e não são textos de interface: mostre
mensagens próprias. Elas aparecem abaixo para depuração e testes, não para o
cliente comparar.

**Ordem das checagens** (a primeira que falha responde): rate limit (429) →
Bearer, nas rotas protegidas (401) → JSON malformado (400) → `X-Client-Type`
(400) → campos do corpo (400) → canal do refresh token (400) → regra de
negócio (400, 401, 404, 409, 429 por conta).

### Por rota

Além dos casos abaixo, toda rota com `X-Client-Type` obrigatório pode
responder os dois 400 do header, e toda rota pode responder 429
`ThrottlerException: Too Many Requests` (ver [Rate limit](#rate-limit)).
JSON malformado no corpo dá 400 com a mensagem do parser (string, por exemplo
`Unexpected end of JSON input`).

**`POST /auth/signup`**

| Status | `message`                                                                                     | Quando                                         |
| ------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 400    | `["email must be an email"]`                                                                  | Email inválido                                 |
| 400    | `["password must be longer than or equal to 8 characters"]`                                   | Senha curta                                    |
| 400    | `["password must be shorter than or equal to 128 characters"]`                                | Senha com mais de 128 caracteres               |
| 400    | `["password must be shorter than or equal to 128 characters after Unicode normalization (NFKC)"]` | Até 128 como enviada, mais de 128 depois do NFKC |
| 400    | `["password has appeared in a known data breach; choose a different one"]`                    | Senha vazada                                   |
| 400    | `["name must be shorter than or equal to 100 characters"]`                                    | Nome longo                                     |
| 400    | `["property <campo> should not exist"]`                                                       | Campo desconhecido                             |
| 409    | `Email already registered`                                                                    | Email já cadastrado                            |
| 409    | `Resource already exists`                                                                     | Dois cadastros simultâneos do mesmo email: um 201, os outros 409 com esta mensagem |

**`POST /auth/login`**

| Status | `message`                                                    | Quando                                                        |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------- |
| 400    | `["email must be an email"]`, `["password must be longer than or equal to 1 characters"]`, `["password must be shorter than or equal to 128 characters"]`, `["property name should not exist"]` | Campos inválidos ou desconhecidos |
| 401    | `Invalid credentials`                                        | Senha errada, email inexistente ou conta sem senha (a mesma resposta nos três casos) |
| 429    | `ThrottlerException: Too Many Requests`                      | Limite por IP ou por conta (ver [Rate limit](#rate-limit))    |

**`POST /auth/refresh`**

| Status | `message`                                                                                                   | Quando                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 400    | `refreshToken must not be sent in the request body when X-Client-Type is web; it is read from the httpOnly cookie` | `web` com `refreshToken` no corpo                    |
| 400    | `refreshToken cookie must not be sent when X-Client-Type is mobile; send refreshToken in the request body`  | `mobile` com o cookie `refreshToken`                         |
| 400    | `["refreshToken must be a jwt string"]`                                                                     | `mobile` com um valor que não tem formato de JWT             |
| 401    | `Missing refresh token`                                                                                     | Sem token no canal certo (cookie ausente ou expirado no browser) |
| 401    | `Invalid refresh token`                                                                                     | Qualquer token recusado: assinatura inválida, expirado, desconhecido, encerrado (logout, logout-all, vinculação) ou reuso |

**`POST /auth/logout`**

| Status | `message`                     | Quando                                                                  |
| ------ | ----------------------------- | ----------------------------------------------------------------------- |
| 204    | —                             | Token revogado, token já inexistente, ou nenhum token no canal certo    |
| 400    | as mesmas do canal errado e do `jwt string` de `/auth/refresh` | Token no canal errado ou malformado    |
| 401    | `Invalid refresh token`       | JWT com assinatura inválida, adulterado ou expirado                     |

**`POST /auth/logout-all`**

| Status | `message`      | Quando                                                       |
| ------ | -------------- | ------------------------------------------------------------ |
| 401    | `Unauthorized` | Sem Bearer, ou access token inválido ou expirado (antes do header) |

**`POST /auth/google/exchange`**

| Status | `message`                                                       | Quando                                   |
| ------ | --------------------------------------------------------------- | ---------------------------------------- |
| 400    | `["code must be longer than or equal to 43 characters"]` (ou `shorter than`) | Tamanho diferente de 43      |
| 401    | `Invalid or expired code`                                       | Código usado, expirado ou inexistente    |

**`GET /me`**

| Status | `message`        | Quando                                                     |
| ------ | ---------------- | ---------------------------------------------------------- |
| 401    | `Unauthorized`   | Sem Bearer, ou access token inválido ou expirado           |
| 404    | `User not found` | Access token válido de um usuário que foi apagado          |

Toda rota protegida por Bearer (`/me`, `/auth/logout-all`, `/activities`)
responde o mesmo 401 `Unauthorized` para access token ausente, malformado,
expirado ou emitido por outro servidor. Rota inexistente: 404
`Cannot <MÉTODO> <caminho>`.

### O que o cliente faz em cada status

| Status | Ação                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Erro do cliente. Em formulário, mostre uma mensagem própria por campo. Em `X-Client-Type` ou canal errado, é bug do interceptor |
| 401    | Em rota com Bearer: refresh e repete uma vez. Em `/auth/refresh`: sessão encerrada. Em `/auth/login`: credenciais inválidas. Em `/auth/google/exchange`: login não concluído |
| 404    | Em `/me`: usuário apagado; limpe a sessão local                                                                                 |
| 409    | No cadastro: "email já em uso", para as duas mensagens                                                                          |
| 429    | "Muitas tentativas, aguarde". Não refaça a ação automaticamente. Não encerra a sessão                                            |
| 5xx    | Erro do servidor. Não encerra a sessão; tente de novo mais tarde                                                                |

## Rate limit

Dois mecanismos, com a mesma resposta 429:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "ThrottlerException: Too Many Requests",
  "path": "/auth/login",
  "timestamp": "2026-10-05T20:58:56.888Z"
}
```

**Por IP e por rota.** Cada rota tem um contador próprio por IP, numa janela
de 1 minuto: 10 em `/auth/signup` e `/auth/login`; 30 em `/auth/refresh` e
`/auth/logout`; 20 em `/auth/google/exchange`, `/auth/logout-all` e
`POST /activities/import`; 100 nas demais (padrão configurável
`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`). O rate limit vem antes de qualquer outra
checagem, inclusive do Bearer: um cliente acima do limite recebe 429 mesmo
sem token. Retry-After: os segundos até o contador zerar (até 60 no padrão).

**Por conta, no login.** O servidor conta cada tentativa de login por email,
exista ou não a conta. Um login bem-sucedido zera a contagem. Passando de
`LOGIN_MAX_FAILURES` tentativas sem sucesso (padrão 5) dentro de
`LOGIN_FAILURE_WINDOW_MINUTES` (padrão 15, contados da primeira tentativa),
**toda** tentativa para aquele email recebe 429, **mesmo com a senha certa**,
até a janela acabar. Com os padrões: as 5 primeiras senhas erradas dão 401, e
a 6ª tentativa já dá 429 com `Retry-After` de até 900. O bloqueio não afeta
sessões abertas (`/auth/refresh`), o login com Google nem outros emails. A
resposta é idêntica à do limite por IP: o cliente não distingue os dois, e
não precisa.

**`Retry-After` no browser.** O header vem em todo 429, em segundos. Mas a
API não o declara em `Access-Control-Expose-Headers`, então o JavaScript de
outra origem (o Angular) **não consegue lê-lo**: `HttpErrorResponse.headers`
não o traz. No web, trate o tempo de espera como desconhecido: mostre
"muitas tentativas, aguarde alguns minutos" e não refaça a request
automaticamente. Os headers `X-RateLimit-*` também não são expostos ao JS e
não fazem parte do contrato.

Em qualquer 429: não diga que a conta foi bloqueada, não repita a request
automaticamente e não limpe a sessão. Um 429 em `/auth/refresh` não é sessão
encerrada: mantenha o estado e tente de novo depois.

## Interceptor

Regras que o servidor impõe, em ordem de gravidade:

1. **Um único refresh em voo.** O refresh token é de uso único; refreshes
   paralelos com o mesmo cookie esgotam a janela de tolerância e encerram a
   sessão. As requests que receberem 401 enquanto um refresh está em
   andamento esperam por ele.
2. **Rotas que não disparam refresh.** Um 401 de `/auth/signup`,
   `/auth/login`, `/auth/refresh`, `/auth/logout` ou `/auth/google/exchange`
   nunca dispara refresh (geraria laço infinito ou esconderia erro de
   credencial). Compare o caminho exato: `/auth/logout-all` usa Bearer e
   **dispara** refresh no 401, como `/me` e `/activities`.
3. **Erro de rede no refresh** (status 0): a renovação pode ter acontecido e a
   resposta se perdido. Não deslogue; repita uma vez, logo em seguida, para
   cair na janela de tolerância. 429 e 5xx no refresh também não deslogam.
4. **`X-Client-Type: web` e `withCredentials: true`** em toda request.

```ts
// Angular (HttpInterceptorFn). Um refresh em voo, requests em fila, repete uma vez.
const NO_REFRESH = new Set([
  '/auth/signup',
  '/auth/login',
  '/auth/refresh',
  '/auth/logout',
  '/auth/google/exchange',
]); // /auth/logout-all fica de fora de propósito: usa Bearer.

let refreshing$: Observable<string> | null = null;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const tokens = inject(AccessTokenStore); // access token só em memória
  const http = inject(HttpClient);
  const router = inject(Router);

  const withAuth = (access: string | null) =>
    req.clone({
      withCredentials: true,
      setHeaders: {
        'X-Client-Type': 'web',
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
      },
    });

  // Ajuste se a URL base da API tiver um prefixo de caminho.
  const path = new URL(req.url, location.origin).pathname;
  if (NO_REFRESH.has(path)) return next(withAuth(tokens.get()));

  return next(withAuth(tokens.get())).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status !== 401) return throwError(() => err);

      // Corpo vazio: o refresh token vai no cookie (no corpo seria 400).
      refreshing$ ??= http.post<{ accessToken: string }>(`${API}/auth/refresh`, {}).pipe(
        // Erro de rede: repete UMA vez, logo, para cair na janela de tolerância.
        retry({ count: 1, delay: (e) => (e.status === 0 ? timer(300) : throwError(() => e)) }),
        map(({ accessToken }) => {
          tokens.set(accessToken);
          return accessToken;
        }),
        catchError((e: HttpErrorResponse) => {
          // Só o 401 encerra a sessão. Rede, 429 e 5xx mantêm o estado.
          if (e.status === 401) {
            tokens.clear();
            router.navigate(['/login']);
          }
          return throwError(() => e);
        }),
        finalize(() => (refreshing$ = null)),
        shareReplay(1),
      );

      // Repete a request original uma vez; um novo 401 sobe para quem chamou.
      return refreshing$.pipe(switchMap((access) => next(withAuth(access))));
    }),
  );
};
```

**Inicialização.** Antes de renderizar rotas protegidas, chame
`/auth/refresh` (basta o cookie). 200: guarde o access token e siga. 401
(`Missing refresh token` ou `Invalid refresh token`): mostre o login, sem
mensagem de erro. Erro de rede: mesma regra do item 3.

**Logout.** Chame `POST /auth/logout` e limpe o estado local qualquer que
seja a resposta. Em "sair de todos os dispositivos" (`POST /auth/logout-all`),
um 401 por access token expirado passa pelo refresh como em qualquer rota com
Bearer; limpe o estado local depois do 204.

## CSRF (fluxo web)

Não há token CSRF, e hoje nenhum é necessário:

- Só `/auth/refresh` e `/auth/logout` autenticam por cookie; o resto
  (inclusive `/auth/logout-all`) usa `Authorization: Bearer`, que um site de
  terceiros não consegue enviar.
- `SameSite=Lax` impede o cookie de acompanhar POSTs cross-site.
- `X-Client-Type` é um header customizado: um formulário HTML não o envia, e
  via JavaScript ele força um preflight CORS, que só `FRONTEND_URL` passa.

**Atenção ao deploy:** o cookie `Lax` só é enviado pelo XHR quando frontend
e API estão no mesmo site registrável (por exemplo, `app.example.com` e
`api.example.com`; em desenvolvimento, `localhost:4200` e `localhost:3000`).
Em sites diferentes (por exemplo, `app.example.net` e `api.example.org`), o
fluxo web quebra; seria preciso `SameSite=None; Secure` **e** um token CSRF,
o que o servidor hoje não oferece.

## O que o cliente não deve assumir

- **Conteúdo do JWT.** Não decodifique o access token nem dependa das claims
  (`sub`, `exp`, `iss`, `aud` etc.); elas já mudaram (o `email` saiu) e podem
  mudar de novo. Dados do usuário: `user` ou `GET /me`. Expiração: o 401.
- **Texto das mensagens de erro.** Decida pelo `statusCode` e pela rota. As
  mensagens podem mudar, e uma mesma situação pode ter mais de uma (o 409 do
  cadastro tem duas).
- **Formato de `message`.** Pode ser string ou array.
- **Refresh token no web.** O JS nunca o vê: não o guarde (nem em
  `localStorage`, `sessionStorage` ou IndexedDB), não leia nem escreva o
  cookie, não o mande no corpo.
- **Cookie `googleOAuthState`.** É do servidor; o cliente não o manipula.
- **Valores fixos.** TTLs, janela de tolerância, limites de rate e do login
  por conta são padrões configuráveis; não os codifique.
- **`Retry-After` e `X-RateLimit-*` no browser.** Não são legíveis pelo JS
  (ver [Rate limit](#rate-limit)).
- **Logout invalidando o access token.** Ele vale até expirar; descarte-o.
- **`hasPassword` imutável.** Pode passar a `false` depois de um login com
  Google.
- **`name` e `avatarUrl` presentes.** Podem ser `null`.
- **`path` sem query string** no corpo de erro.
- **Swagger em produção.** `/docs` e `/docs-json` não existem lá.

## Lacunas conhecidas

Não implementadas; o cliente não deve contar com elas:

- **Verificação de email e reset de senha** (dependem de envio de email).
- **Definição de senha para conta sem senha** (`hasPassword: false`).
- **Alteração de perfil** (nome, avatar). `GET /me` é somente leitura.
- **Login nativo com Google no Android** (`POST /auth/google/token` com o
  `idToken`). Hoje só existe o fluxo de redirect, que termina no web.
- **`SameSite=None` configurável**: `Lax` é fixo no código.
- **`Retry-After` legível no browser** (falta `Access-Control-Expose-Headers`).

## Histórico de mudanças

Mudanças de comportamento que o cliente web precisa absorver desde a versão
inicial do contrato (2026-09-23). Datas dos commits na `main`; os códigos
`A-xx` são os achados de [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md).

- [ ] **2026-09-30 — Vinculação ao Google de conta não verificada (A-01).**
      `hasPassword` passa a `false`, a senha antiga deixa de valer (401) e
      as sessões anteriores recebem 401 no refresh. Não ofereça login por
      senha com `hasPassword: false`.
- [ ] **2026-09-30 — Swagger só fora de produção (A-10).** Não dependa de
      `/docs-json` em produção (por exemplo, para gerar clientes em runtime).
- [ ] **2026-09-30 — Cookie com `Secure` por padrão e `Max-Age` real (A-11).**
      Antes: `Max-Age=604800` fixo e `Secure` só em produção. Agora: `Secure`
      também em desenvolvimento (Safari em `http://` precisa de
      `COOKIE_SECURE=false` na API local) e `Max-Age` igual à validade
      restante do token, com `Expires`.
- [ ] **2026-10-01 — Um único 401 no refresh (A-18) e novas claims (A-14).**
      As mensagens `Refresh token reuse detected` e `Refresh token expired`
      não existem mais: todo token recusado recebe `Invalid refresh token`;
      token ausente recebe `Missing refresh token`. Os tokens emitidos antes
      desta mudança deixaram de valer (cada usuário refez o login uma vez).
- [ ] **2026-10-01 — Login com Google com `state`/PKCE e `?error=` (A-02,
      A-13).** O callback não termina mais em JSON na API: toda falha volta
      para `/auth/callback?error=<código>`. Trate os quatro códigos e qualquer
      outro como `oauth_failed`. O browser precisa aceitar o cookie
      `googleOAuthState` da API.
- [ ] **2026-10-01 — Sessões por família e janela de tolerância (A-04,
      A-17).** Antes, um reuso derrubava todas as sessões do usuário. Agora
      encerra só a sessão daquele browser, e um token recém-trocado pode ser
      repetido uma vez em até 30 s (padrão). O interceptor deve repetir o
      refresh uma vez em erro de rede e deslogar só em 401.
- [ ] **2026-10-01 — `POST /auth/logout-all` (A-08).** Nova opção "sair de
      todos os dispositivos" (Bearer + `X-Client-Type: web`, 204). Ela passa
      pelo refresh no 401, ao contrário das demais rotas de auth.
- [ ] **2026-10-02 — Limites por rota e por conta (A-03).** Refresh e logout:
      30/min; troca do Google e logout-all: 20/min; login: limite por email
      que responde 429 mesmo com a senha certa. 429 não encerra sessão.
- [ ] **2026-10-02 — NFKC e senha vazada no cadastro (A-09).** Dois novos 400
      no cadastro (senha vazada; mais de 128 caracteres depois do NFKC). Envie
      a senha como digitada.
- [ ] **2026-10-02 — Access token sem `email` (A-21).** Quem lia o email do
      token deve usar `user.email` ou `GET /me`.
- [ ] **2026-10-05 — Revisão deste contrato.** Sem mudança de servidor, mas
      com regras novas para o cliente: `/auth/logout-all` dispara refresh no
      401 (compare caminhos exatos, não prefixo `/auth/`); o `Retry-After` não
      é legível no browser; o 409 do cadastro tem duas mensagens.
