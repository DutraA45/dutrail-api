import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Redirect,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiExcludeEndpoint,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ApiClientTypeHeader,
  ClientType,
} from '../common/decorators/client-type.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { EnvironmentVariables } from '../config/env.validation.js';
import type { User } from '../generated/prisma/client.js';
import { securityContextFrom } from '../security/security-context.js';
import { SecurityLogService } from '../security/security-log.service.js';
import { AuthService, type AuthResult } from './auth.service.js';
import {
  ApiAuthResponse,
  ApiRefreshResponse,
} from './decorators/api-auth-response.decorator.js';
import {
  AccessTokenDto,
  AuthMobileResponseDto,
  AuthWebResponseDto,
  TokenPairDto,
} from './dto/auth-response.dto.js';
import { ExchangeCodeDto } from './dto/exchange-code.dto.js';
import { GoogleCallbackFilter } from './filters/google-callback.filter.js';
import { frontendCallbackUrl, GoogleCallbackError } from './google-callback.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { GoogleAuthGuard } from './guards/google-auth.guard.js';
import { GoogleCallbackGuard } from './guards/google-callback.guard.js';
import { RefreshTokenTransport } from './refresh-token-transport.service.js';

/**
 * Limite mais apertado para rotas que aceitam credenciais: dificulta força
 * bruta e "credential stuffing". O limite global (THROTTLE_*) continua
 * valendo para o resto da API.
 */
const CREDENTIALS_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

const CLIENT_TYPE_ERROR =
  'Body inválido ou header X-Client-Type ausente/inválido';

// Todas as rotas deste controller são @Public(): quem "autentica" aqui é a
// própria credencial enviada (senha, refresh token, código do Google).
//
// Cada handler monta o SecurityContext (ip, user-agent, client type) a partir
// do `req` e o passa aos services, que registram os eventos de segurança.
//
// O refresh token muda de canal conforme o X-Client-Type (cookie httpOnly para
// web, corpo JSON para mobile). Só a entrega/leitura muda: rotação, detecção de
// reuso e revogação são as mesmas para os dois, no TokenService.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly transport: RefreshTokenTransport,
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly securityLog: SecurityLogService,
  ) {}

  @Public()
  @Post('signup')
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiClientTypeHeader()
  @ApiOperation({ summary: 'Cadastro com email e senha' })
  @ApiAuthResponse(HttpStatus.CREATED)
  @ApiBadRequestResponse({
    description: CLIENT_TYPE_ERROR,
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'Email já cadastrado',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit excedido',
    type: ErrorResponseDto,
  })
  async signup(
    @Body() dto: SignupDto,
    @ClientType() clientType: ClientType,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthWebResponseDto | AuthMobileResponseDto> {
    const result = await this.authService.signup(
      dto.email,
      dto.password,
      dto.name,
      securityContextFrom(req, clientType),
    );
    return this.respondWithTokens(result, clientType, res);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIALS_THROTTLE)
  @ApiClientTypeHeader()
  @ApiOperation({ summary: 'Login com email e senha' })
  @ApiAuthResponse(HttpStatus.OK)
  @ApiBadRequestResponse({
    description: CLIENT_TYPE_ERROR,
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Credenciais inválidas',
    type: ErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit excedido',
    type: ErrorResponseDto,
  })
  async login(
    @Body() dto: LoginDto,
    @ClientType() clientType: ClientType,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthWebResponseDto | AuthMobileResponseDto> {
    const result = await this.authService.login(
      dto.email,
      dto.password,
      securityContextFrom(req, clientType),
    );
    return this.respondWithTokens(result, clientType, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiClientTypeHeader()
  @ApiOperation({
    summary: 'Troca um refresh token por um novo par de tokens',
    description:
      'Lê o refresh token do cookie httpOnly (`web`) ou do corpo (`mobile`). O token enviado é ' +
      'invalidado (rotação). Por REFRESH_GRACE_SECONDS (padrão 30 s) ele ainda pode ser repetido ' +
      'uma vez (resposta perdida) e recebe um par novo da mesma sessão; fora disso, reapresentá-lo ' +
      'é reuso e encerra a sessão daquele dispositivo (as outras continuam).',
  })
  @ApiRefreshResponse()
  @ApiBadRequestResponse({
    description: `${CLIENT_TYPE_ERROR}, ou refresh token enviado no canal errado`,
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Refresh token ausente, inválido, expirado ou revogado',
    type: ErrorResponseDto,
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @ClientType() clientType: ClientType,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenDto | TokenPairDto> {
    const ctx = securityContextFrom(req, clientType);
    const refreshToken = this.transport.read(clientType, req, dto.refreshToken);
    if (refreshToken === undefined) {
      // Canal certo, mas vazio (cookie expirado/nunca setado, ou body sem o
      // campo): é falta de credencial, então 401 — o cliente deve refazer login.
      this.securityLog.warn('refresh_invalid', ctx, {
        reason: 'missing_token',
      });
      throw new UnauthorizedException('Missing refresh token');
    }

    const tokens = await this.authService.refresh(refreshToken, ctx);
    const bodyToken = this.transport.deliver(clientType, res, tokens);

    return bodyToken === undefined
      ? AccessTokenDto.fromTokens(tokens)
      : TokenPairDto.fromTokens(tokens);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiClientTypeHeader()
  @ApiOperation({
    summary: 'Invalida o refresh token atual',
    description:
      'Revoga o token no banco e, no fluxo web, apaga o cookie. O access token continua válido ' +
      'até expirar (é stateless); o cliente deve descartá-lo.',
  })
  @ApiNoContentResponse({
    description: 'Refresh token revogado (ou já não existia)',
  })
  @ApiBadRequestResponse({
    description: `${CLIENT_TYPE_ERROR}, ou refresh token enviado no canal errado`,
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Refresh token com assinatura inválida',
    type: ErrorResponseDto,
  })
  async logout(
    @Body() dto: RefreshTokenDto,
    @ClientType() clientType: ClientType,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const ctx = securityContextFrom(req, clientType);
    const refreshToken = this.transport.read(clientType, req, dto.refreshToken);

    // Logout é idempotente: sem token no canal certo não há o que revogar,
    // mas o cookie (se houver) ainda é apagado.
    if (refreshToken !== undefined) {
      await this.authService.logout(refreshToken, ctx);
    } else {
      this.securityLog.log('logout', ctx, { reason: 'no_token' });
    }
    this.transport.clear(clientType, res);
  }

  /**
   * O guard faz tudo: a GoogleStrategy seta o cookie de state (A-02) e responde
   * com um 302 para o Google; o corpo deste método nunca executa.
   *
   * Sem X-Client-Type: é uma navegação do browser, que não permite headers
   * customizados. O tipo de cliente é declarado depois, no /auth/google/exchange.
   */
  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiOperation({
    summary: 'Inicia o login com Google',
    description:
      'Abra esta URL no browser (window.location); ela redireciona para a tela de consentimento ' +
      'do Google e seta um cookie curto (state + PKCE) que o callback confere. Não aceita ' +
      'header X-Client-Type.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect para accounts.google.com',
  })
  googleLogin(): void {}

  /**
   * URL cadastrada no Google Console. Aqui o guard já conferiu o state, trocou
   * o code e rodou a strategy: `req.user` é o usuário criado/vinculado. Em vez
   * de colocar tokens na URL (histórico do browser, logs de proxy), geramos um
   * código de uso único e o frontend o troca por tokens em
   * POST /auth/google/exchange.
   *
   * Falhas (no guard ou aqui) viram GoogleCallbackError, que o
   * GoogleCallbackFilter converte em redirect com `?error=<código>` (A-13).
   */
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleCallbackGuard)
  @UseFilters(GoogleCallbackFilter)
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiExcludeEndpoint() // chamado só pelo Google; não faz sentido no Swagger
  async googleCallback(
    @Req() req: Request & { user: User },
  ): Promise<{ url: string }> {
    let code: string;
    try {
      code = await this.authService.createExchangeCode(req.user.id);
    } catch (err) {
      throw new GoogleCallbackError('oauth_failed', err);
    }
    return {
      url: frontendCallbackUrl(
        this.config.get('FRONTEND_URL', { infer: true }),
        { code },
      ),
    };
  }

  @Public()
  @Post('google/exchange')
  @HttpCode(HttpStatus.OK)
  @ApiClientTypeHeader()
  @ApiOperation({ summary: 'Troca o código do callback do Google por tokens' })
  @ApiAuthResponse(HttpStatus.OK)
  @ApiBadRequestResponse({
    description: CLIENT_TYPE_ERROR,
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Código inválido, expirado ou já usado',
    type: ErrorResponseDto,
  })
  async googleExchange(
    @Body() dto: ExchangeCodeDto,
    @ClientType() clientType: ClientType,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthWebResponseDto | AuthMobileResponseDto> {
    const result = await this.authService.exchangeCode(
      dto.code,
      securityContextFrom(req, clientType),
    );
    return this.respondWithTokens(result, clientType, res);
  }

  /**
   * Ponto único de entrega dos tokens: seta o cookie (web) ou devolve o
   * refresh no corpo (mobile). Usado por signup, login e google/exchange para
   * que os três não possam divergir.
   */
  private respondWithTokens(
    result: AuthResult,
    clientType: ClientType,
    res: Response,
  ): AuthWebResponseDto | AuthMobileResponseDto {
    const bodyToken = this.transport.deliver(clientType, res, result);
    return bodyToken === undefined
      ? AuthWebResponseDto.fromResult(result)
      : AuthMobileResponseDto.fromResult(result);
  }
}
