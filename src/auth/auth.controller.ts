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
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { SignupDto } from './dto/signup.dto.js';
import { GoogleAuthGuard } from './guards/google-auth.guard.js';
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthWebResponseDto | AuthMobileResponseDto> {
    const result = await this.authService.signup(
      dto.email,
      dto.password,
      dto.name,
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthWebResponseDto | AuthMobileResponseDto> {
    const result = await this.authService.login(dto.email, dto.password);
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
      'invalidado (rotação); reapresentar um token já usado revoga todas as sessões do usuário.',
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
    const refreshToken = this.transport.read(clientType, req, dto.refreshToken);
    if (refreshToken === undefined) {
      // Canal certo, mas vazio (cookie expirado/nunca setado, ou body sem o
      // campo): é falta de credencial, então 401 — o cliente deve refazer login.
      throw new UnauthorizedException('Missing refresh token');
    }

    const tokens = await this.authService.refresh(refreshToken);
    const bodyToken = this.transport.deliver(
      clientType,
      res,
      tokens.refreshToken,
    );

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
    const refreshToken = this.transport.read(clientType, req, dto.refreshToken);

    // Logout é idempotente: sem token no canal certo não há o que revogar,
    // mas o cookie (se houver) ainda é apagado.
    if (refreshToken !== undefined) {
      await this.authService.logout(refreshToken);
    }
    this.transport.clear(clientType, res);
  }

  /**
   * O guard faz tudo: a GoogleStrategy responde com um 302 para o Google e o
   * corpo deste método nunca executa.
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
      'do Google. Não aceita header X-Client-Type.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect para accounts.google.com',
  })
  googleLogin(): void {}

  /**
   * URL cadastrada no Google Console. Aqui o guard já rodou a strategy e
   * `req.user` é o usuário criado/vinculado. Em vez de colocar tokens na URL
   * (histórico do browser, logs de proxy), geramos um código de uso único e
   * o frontend o troca por tokens em POST /auth/google/exchange.
   */
  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  @Redirect(undefined, HttpStatus.FOUND)
  @ApiExcludeEndpoint() // chamado só pelo Google; não faz sentido no Swagger
  async googleCallback(
    @Req() req: Request & { user: User },
  ): Promise<{ url: string }> {
    const code = await this.authService.createExchangeCode(req.user.id);
    const frontend = this.config.get('FRONTEND_URL', { infer: true });
    return {
      url: `${frontend}/auth/callback?code=${encodeURIComponent(code)}`,
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthWebResponseDto | AuthMobileResponseDto> {
    const result = await this.authService.exchangeCode(dto.code);
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
    const bodyToken = this.transport.deliver(
      clientType,
      res,
      result.refreshToken,
    );
    return bodyToken === undefined
      ? AuthWebResponseDto.fromResult(result)
      : AuthMobileResponseDto.fromResult(result);
  }
}
