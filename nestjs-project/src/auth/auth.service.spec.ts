import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import authConfig from '../config/auth.config';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../common/exceptions/domain.exception';
import { MailService } from '../mail/mail.service';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

const mockAuthConfig = {
  jwtSecret: 'test-secret',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtAccessExpiration: '15m',
  jwtRefreshExpiration: '7d',
  confirmationTokenExpirationHours: 1,
  passwordResetTokenExpirationHours: 1,
};

interface UpdateQueryBuilderMock<TEntity> {
  update: jest.MockedFunction<() => UpdateQueryBuilderMock<TEntity>>;
  set: jest.MockedFunction<
    (values: Partial<TEntity>) => UpdateQueryBuilderMock<TEntity>
  >;
  where: jest.MockedFunction<
    (
      query: string,
      parameters?: Record<string, unknown>,
    ) => UpdateQueryBuilderMock<TEntity>
  >;
  andWhere: jest.MockedFunction<
    (
      query: string,
      parameters?: Record<string, unknown>,
    ) => UpdateQueryBuilderMock<TEntity>
  >;
  execute: jest.MockedFunction<() => Promise<void>>;
}

interface UsersServiceMock {
  findByEmail: jest.MockedFunction<UsersService['findByEmail']>;
  findByEmailWithChannel: jest.MockedFunction<
    UsersService['findByEmailWithChannel']
  >;
  createUserWithChannel: jest.MockedFunction<
    UsersService['createUserWithChannel']
  >;
  save: jest.MockedFunction<UsersService['save']>;
}

interface MailServiceMock {
  sendConfirmationEmail: jest.MockedFunction<
    MailService['sendConfirmationEmail']
  >;
  sendPasswordResetEmail: jest.MockedFunction<
    MailService['sendPasswordResetEmail']
  >;
}

interface VerificationTokenRepositoryMock {
  create: jest.MockedFunction<
    (entityLike: Partial<VerificationToken>) => VerificationToken
  >;
  save: jest.MockedFunction<
    (entity: VerificationToken) => Promise<VerificationToken>
  >;
  findOne: jest.MockedFunction<
    (options: unknown) => Promise<VerificationToken | null>
  >;
  createQueryBuilder: jest.MockedFunction<
    () => UpdateQueryBuilderMock<VerificationToken>
  >;
}

interface RefreshTokenRepositoryMock {
  create: jest.MockedFunction<
    (entityLike: Partial<RefreshToken>) => RefreshToken
  >;
  save: jest.MockedFunction<(entity: RefreshToken) => Promise<RefreshToken>>;
  findOne: jest.MockedFunction<
    (options: unknown) => Promise<RefreshToken | null>
  >;
  createQueryBuilder: jest.MockedFunction<
    () => UpdateQueryBuilderMock<RefreshToken>
  >;
}

interface TestModuleContext {
  module: TestingModule;
  usersService: UsersServiceMock;
  mailService: MailServiceMock;
  verificationTokenRepository: VerificationTokenRepositoryMock;
  refreshTokenRepository: RefreshTokenRepositoryMock;
}

function buildChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'c1',
    name: 'channel-name',
    nickname: 'channel-nickname',
    description: null,
    user_id: 'u1',
    created_at: new Date(),
    updated_at: new Date(),
    user: undefined as unknown as User,
    ...overrides,
  };
}

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'user@example.com',
    password: 'hashed-password',
    is_confirmed: false,
    created_at: new Date(),
    updated_at: new Date(),
    channel: buildChannel(),
    ...overrides,
  };
}

function buildVerificationToken(
  overrides: Partial<VerificationToken> = {},
): VerificationToken {
  return {
    id: 'vt1',
    token_hash: 'verification-hash',
    type: VerificationTokenType.EMAIL_CONFIRMATION,
    user_id: 'u1',
    expires_at: new Date(Date.now() + 60_000),
    used_at: null,
    created_at: new Date(),
    user: buildUser({ id: 'u1' }),
    ...overrides,
  };
}

function buildRefreshToken(
  overrides: Partial<RefreshToken> = {},
): RefreshToken {
  return {
    id: 'rt1',
    token_hash: 'refresh-hash',
    family: '550e8400-e29b-41d4-a716-446655440000',
    user_id: 'u1',
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
    created_at: new Date(),
    user: buildUser({
      id: 'u1',
      channel: buildChannel({ id: 'c1', user_id: 'u1' }),
    }),
    ...overrides,
  };
}

function createUpdateQueryBuilderMock<
  TEntity,
>(): UpdateQueryBuilderMock<TEntity> {
  const queryBuilder = {
    update: jest.fn<UpdateQueryBuilderMock<TEntity>, []>(),
    set: jest.fn<UpdateQueryBuilderMock<TEntity>, [Partial<TEntity>]>(),
    where: jest.fn<
      UpdateQueryBuilderMock<TEntity>,
      [string, Record<string, unknown>?]
    >(),
    andWhere: jest.fn<
      UpdateQueryBuilderMock<TEntity>,
      [string, Record<string, unknown>?]
    >(),
    execute: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  } satisfies UpdateQueryBuilderMock<TEntity>;

  queryBuilder.update.mockReturnValue(queryBuilder);
  queryBuilder.set.mockReturnValue(queryBuilder);
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);

  return queryBuilder;
}

function createUsersServiceMock(): UsersServiceMock {
  return {
    findByEmail: jest.fn<
      ReturnType<UsersService['findByEmail']>,
      Parameters<UsersService['findByEmail']>
    >(),
    findByEmailWithChannel: jest.fn<
      ReturnType<UsersService['findByEmailWithChannel']>,
      Parameters<UsersService['findByEmailWithChannel']>
    >(),
    createUserWithChannel: jest.fn<
      ReturnType<UsersService['createUserWithChannel']>,
      Parameters<UsersService['createUserWithChannel']>
    >(),
    save: jest
      .fn<ReturnType<UsersService['save']>, Parameters<UsersService['save']>>()
      .mockImplementation((user: User) => Promise.resolve(user)),
  };
}

function createMailServiceMock(): MailServiceMock {
  return {
    sendConfirmationEmail: jest
      .fn<
        ReturnType<MailService['sendConfirmationEmail']>,
        Parameters<MailService['sendConfirmationEmail']>
      >()
      .mockResolvedValue(undefined),
    sendPasswordResetEmail: jest
      .fn<
        ReturnType<MailService['sendPasswordResetEmail']>,
        Parameters<MailService['sendPasswordResetEmail']>
      >()
      .mockResolvedValue(undefined),
  };
}

function createVerificationTokenRepositoryMock(): VerificationTokenRepositoryMock {
  return {
    create: jest
      .fn<VerificationToken, [Partial<VerificationToken>]>()
      .mockImplementation((entityLike: Partial<VerificationToken>) =>
        buildVerificationToken(entityLike),
      ),
    save: jest
      .fn<Promise<VerificationToken>, [VerificationToken]>()
      .mockImplementation((entity: VerificationToken) =>
        Promise.resolve(entity),
      ),
    findOne: jest
      .fn<Promise<VerificationToken | null>, [unknown]>()
      .mockResolvedValue(null),
    createQueryBuilder: jest
      .fn<UpdateQueryBuilderMock<VerificationToken>, []>()
      .mockImplementation(() =>
        createUpdateQueryBuilderMock<VerificationToken>(),
      ),
  };
}

function createRefreshTokenRepositoryMock(): RefreshTokenRepositoryMock {
  return {
    create: jest
      .fn<RefreshToken, [Partial<RefreshToken>]>()
      .mockImplementation((entityLike: Partial<RefreshToken>) =>
        buildRefreshToken(entityLike),
      ),
    save: jest
      .fn<Promise<RefreshToken>, [RefreshToken]>()
      .mockImplementation((entity: RefreshToken) => Promise.resolve(entity)),
    findOne: jest
      .fn<Promise<RefreshToken | null>, [unknown]>()
      .mockResolvedValue(null),
    createQueryBuilder: jest
      .fn<UpdateQueryBuilderMock<RefreshToken>, []>()
      .mockImplementation(() => createUpdateQueryBuilderMock<RefreshToken>()),
  };
}

describe('AuthService — register', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let mailService: MailServiceMock;
  let verificationTokenRepository: VerificationTokenRepositoryMock;

  beforeEach(async () => {
    const context = await buildTestModule();

    authService = context.module.get(AuthService);
    usersService = context.usersService;
    mailService = context.mailService;
    verificationTokenRepository = context.verificationTokenRepository;
  });

  it('throws EmailAlreadyExistsException when email is already registered', async () => {
    usersService.findByEmail.mockResolvedValue(
      buildUser({ id: 'u1', email: 'test@example.com' }),
    );

    await expect(
      authService.register({
        email: 'test@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(EmailAlreadyExistsException);
  });

  it('hashes the password before creating the user', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'new@example.com',
        channel: buildChannel({ name: 'new' }),
      }),
    );

    await authService.register({
      email: 'new@example.com',
      password: 'plaintext',
    });

    const [, hashedPassword] = usersService.createUserWithChannel.mock.calls[0];
    expect(hashedPassword).not.toBe('plaintext');
    expect(hashedPassword).toMatch(/^\$argon2/);
  });

  it('calls createUserWithChannel with the correct email', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'new@example.com',
        channel: buildChannel({ name: 'new' }),
      }),
    );

    await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(usersService.createUserWithChannel.mock.calls[0]).toEqual([
      'new@example.com',
      expect.any(String),
    ]);
  });

  it('stores a verification token with EMAIL_CONFIRMATION type', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'new@example.com',
        channel: buildChannel({ name: 'new' }),
      }),
    );
    const createdToken = buildVerificationToken({
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      user_id: 'u1',
    });
    verificationTokenRepository.create.mockReturnValue(createdToken);

    await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(verificationTokenRepository.create.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'u1',
      }),
    ]);
    expect(verificationTokenRepository.save.mock.calls[0]).toEqual([
      createdToken,
    ]);
  });

  it('sends a confirmation email with the raw token', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'new@example.com',
        channel: buildChannel({ name: 'mynick' }),
      }),
    );

    await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(mailService.sendConfirmationEmail.mock.calls[0]).toEqual([
      'new@example.com',
      'mynick',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });

  it('returns the user id and email', async () => {
    usersService.findByEmail.mockResolvedValue(null);
    usersService.createUserWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'new@example.com',
        channel: buildChannel({ name: 'new' }),
      }),
    );

    const result = await authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(result).toEqual({ id: 'u1', email: 'new@example.com' });
  });
});

async function buildTestModule(): Promise<TestModuleContext> {
  const usersService = createUsersServiceMock();
  const mailService = createMailServiceMock();
  const verificationTokenRepository = createVerificationTokenRepositoryMock();
  const refreshTokenRepository = createRefreshTokenRepositoryMock();

  const module = await Test.createTestingModule({
    imports: [
      JwtModule.register({
        secret: 'test-secret',
        signOptions: { expiresIn: '15m' },
      }),
    ],
    providers: [
      AuthService,
      {
        provide: UsersService,
        useValue: usersService,
      },
      {
        provide: MailService,
        useValue: mailService,
      },
      {
        provide: getRepositoryToken(VerificationToken),
        useValue: verificationTokenRepository,
      },
      {
        provide: getRepositoryToken(RefreshToken),
        useValue: refreshTokenRepository,
      },
      {
        provide: authConfig.KEY,
        useValue: mockAuthConfig,
      },
    ],
  }).compile();

  return {
    module,
    usersService,
    mailService,
    verificationTokenRepository,
    refreshTokenRepository,
  };
}

describe('AuthService — confirm', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let verificationTokenRepository: VerificationTokenRepositoryMock;

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    usersService = context.usersService;
    verificationTokenRepository = context.verificationTokenRepository;
  });

  it('marks user as confirmed and token as used for a valid token', async () => {
    const rawToken = 'a'.repeat(64);
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const user = buildUser({ id: 'u1', is_confirmed: false });
    const record = buildVerificationToken({
      token_hash: tokenHash,
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
      user,
    });

    verificationTokenRepository.findOne.mockResolvedValue(record);

    await authService.confirm(rawToken);

    expect(record.used_at).toBeInstanceOf(Date);
    expect(user.is_confirmed).toBe(true);
    expect(verificationTokenRepository.save.mock.calls[0]).toEqual([record]);
    expect(usersService.save.mock.calls[0]).toEqual([user]);
  });

  it('throws InvalidTokenException when token is not found', async () => {
    verificationTokenRepository.findOne.mockResolvedValue(null);

    await expect(authService.confirm('nonexistent-token')).rejects.toThrow(
      InvalidTokenException,
    );
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const rawToken = 'b'.repeat(64);
    const record = buildVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      used_at: null,
      expires_at: new Date(Date.now() - 1000),
      user: buildUser({ id: 'u1', is_confirmed: false }),
    });

    verificationTokenRepository.findOne.mockResolvedValue(record);

    await expect(authService.confirm(rawToken)).rejects.toThrow(
      TokenExpiredException,
    );
  });
});

describe('AuthService — resendConfirmation', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let mailService: MailServiceMock;
  let verificationTokenRepository: VerificationTokenRepositoryMock;

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    usersService = context.usersService;
    mailService = context.mailService;
    verificationTokenRepository = context.verificationTokenRepository;
  });

  it('returns silently when email is not found', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      authService.resendConfirmation('unknown@example.com'),
    ).resolves.toBeUndefined();
    expect(mailService.sendConfirmationEmail.mock.calls).toHaveLength(0);
  });

  it('returns silently when user is already confirmed', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        is_confirmed: true,
        channel: buildChannel({ name: 'nick' }),
      }),
    );

    await expect(
      authService.resendConfirmation('confirmed@example.com'),
    ).resolves.toBeUndefined();
    expect(mailService.sendConfirmationEmail.mock.calls).toHaveLength(0);
  });

  it('invalidates old tokens and sends a new confirmation email', async () => {
    const user = buildUser({
      id: 'u1',
      email: 'user@example.com',
      is_confirmed: false,
      channel: buildChannel({ name: 'nick' }),
    });
    usersService.findByEmailWithChannel.mockResolvedValue(user);

    const qbMock = createUpdateQueryBuilderMock<VerificationToken>();
    verificationTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await authService.resendConfirmation('user@example.com');

    expect(qbMock.execute.mock.calls).toHaveLength(1);
    expect(verificationTokenRepository.create.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'u1',
      }),
    ]);
    expect(mailService.sendConfirmationEmail.mock.calls[0]).toEqual([
      'user@example.com',
      'nick',
      expect.any(String),
    ]);
  });
});

describe('AuthService — login', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let refreshTokenRepository: RefreshTokenRepositoryMock;
  let hashedTestPassword: string;

  beforeAll(async () => {
    hashedTestPassword = await argon2.hash('correctpassword');
  });

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    usersService = context.usersService;
    refreshTokenRepository = context.refreshTokenRepository;
  });

  it('throws InvalidCredentialsException when email is not found', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      authService.login({
        email: 'nobody@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(InvalidCredentialsException);
  });

  it('throws InvalidCredentialsException when password is wrong', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'user@example.com',
        password: hashedTestPassword,
        is_confirmed: true,
        channel: buildChannel({ id: 'c1' }),
      }),
    );

    await expect(
      authService.login({
        email: 'user@example.com',
        password: 'wrongpassword',
      }),
    ).rejects.toThrow(InvalidCredentialsException);
  });

  it('throws EmailNotConfirmedException when user is not confirmed', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'user@example.com',
        password: hashedTestPassword,
        is_confirmed: false,
        channel: buildChannel({ id: 'c1' }),
      }),
    );

    await expect(
      authService.login({
        email: 'user@example.com',
        password: 'correctpassword',
      }),
    ).rejects.toThrow(EmailNotConfirmedException);
  });

  it('returns access_token and refresh_token on valid credentials', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(
      buildUser({
        id: 'u1',
        email: 'user@example.com',
        password: hashedTestPassword,
        is_confirmed: true,
        channel: buildChannel({ id: 'c1' }),
      }),
    );

    const result = await authService.login({
      email: 'user@example.com',
      password: 'correctpassword',
    });

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.refresh_token).toBe('string');
    expect(refreshTokenRepository.save.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('AuthService — refresh', () => {
  let authService: AuthService;
  let refreshTokenRepository: RefreshTokenRepositoryMock;

  const mockUser = buildUser({
    id: 'u1',
    email: 'user@example.com',
    channel: buildChannel({ id: 'c1' }),
  });
  const rawToken = 'a'.repeat(64);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    refreshTokenRepository = context.refreshTokenRepository;
  });

  it('throws InvalidTokenException when token is not found', async () => {
    refreshTokenRepository.findOne.mockResolvedValue(null);

    await expect(authService.refresh(rawToken)).rejects.toThrow(
      InvalidTokenException,
    );
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const record = buildRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() - 1000),
      revoked_at: null,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);

    await expect(authService.refresh(rawToken)).rejects.toThrow(
      TokenExpiredException,
    );
  });

  it('rotates token: revokes old, persists new, returns both tokens', async () => {
    const record = buildRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);

    const result = await authService.refresh(rawToken);

    expect(record.revoked_at).toBeInstanceOf(Date);
    expect(refreshTokenRepository.save.mock.calls[0]).toEqual([record]);
    expect(refreshTokenRepository.create.mock.calls[0]).toEqual([
      expect.objectContaining({ family: 'family-uuid', user_id: 'u1' }),
    ]);
    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(result.refresh_token).not.toBe(rawToken);
  });

  it('returns new access token without revoking family when reuse is within grace period', async () => {
    const revokedAt = new Date(Date.now() - 5_000);
    const record = buildRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: revokedAt,
    });
    refreshTokenRepository.findOne
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(buildRefreshToken({ token_hash: 'active-token' }));

    const result = await authService.refresh(rawToken);

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBe(rawToken);
    expect(refreshTokenRepository.createQueryBuilder.mock.calls).toHaveLength(
      0,
    );
  });

  it('revokes entire family and throws TokenReuseDetectedException beyond grace period', async () => {
    const revokedAt = new Date(Date.now() - 15_000);
    const record = buildRefreshToken({
      token_hash: tokenHash,
      family: 'family-uuid',
      user_id: 'u1',
      user: mockUser,
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: revokedAt,
    });
    refreshTokenRepository.findOne.mockResolvedValue(record);

    const qbMock = createUpdateQueryBuilderMock<RefreshToken>();
    refreshTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await expect(authService.refresh(rawToken)).rejects.toThrow(
      TokenReuseDetectedException,
    );

    expect(qbMock.execute.mock.calls).toHaveLength(1);
    expect(qbMock.where.mock.calls[0]).toEqual([
      'family = :family',
      {
        family: 'family-uuid',
      },
    ]);
  });
});

describe('AuthService — logout', () => {
  let authService: AuthService;
  let refreshTokenRepository: RefreshTokenRepositoryMock;

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    refreshTokenRepository = context.refreshTokenRepository;
  });

  it('revokes all active refresh tokens for the user', async () => {
    const qbMock = createUpdateQueryBuilderMock<RefreshToken>();
    refreshTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await authService.logout('user-id-123');

    const [setValues] = qbMock.set.mock.calls[0];

    expect(setValues.revoked_at).toBeInstanceOf(Date);
    expect(qbMock.where.mock.calls[0]).toEqual([
      'user_id = :userId',
      {
        userId: 'user-id-123',
      },
    ]);
    expect(qbMock.andWhere.mock.calls[0]).toEqual(['revoked_at IS NULL']);
    expect(qbMock.execute.mock.calls).toHaveLength(1);
  });
});

describe('AuthService — forgotPassword', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let mailService: MailServiceMock;
  let verificationTokenRepository: VerificationTokenRepositoryMock;

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    usersService = context.usersService;
    mailService = context.mailService;
    verificationTokenRepository = context.verificationTokenRepository;
  });

  it('returns silently when email is not registered', async () => {
    usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      authService.forgotPassword('unknown@example.com'),
    ).resolves.toBeUndefined();
    expect(mailService.sendPasswordResetEmail.mock.calls).toHaveLength(0);
  });

  it('invalidates previous reset tokens and sends a reset email', async () => {
    const user = buildUser({
      id: 'u1',
      email: 'user@example.com',
      channel: buildChannel({ name: 'nick' }),
    });
    usersService.findByEmailWithChannel.mockResolvedValue(user);

    const qbMock = createUpdateQueryBuilderMock<VerificationToken>();
    verificationTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await authService.forgotPassword('user@example.com');

    expect(qbMock.execute.mock.calls).toHaveLength(1);
    expect(qbMock.andWhere.mock.calls[0]).toEqual([
      'type = :type',
      {
        type: VerificationTokenType.PASSWORD_RESET,
      },
    ]);
    expect(verificationTokenRepository.create.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'u1',
      }),
    ]);
    expect(mailService.sendPasswordResetEmail.mock.calls[0]).toEqual([
      'user@example.com',
      'nick',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
  });
});

describe('AuthService — resetPassword', () => {
  let authService: AuthService;
  let usersService: UsersServiceMock;
  let verificationTokenRepository: VerificationTokenRepositoryMock;
  let refreshTokenRepository: RefreshTokenRepositoryMock;

  beforeEach(async () => {
    const context = await buildTestModule();
    authService = context.module.get(AuthService);
    usersService = context.usersService;
    verificationTokenRepository = context.verificationTokenRepository;
    refreshTokenRepository = context.refreshTokenRepository;
  });

  it('throws InvalidTokenException when token is not found', async () => {
    verificationTokenRepository.findOne.mockResolvedValue(null);

    await expect(
      authService.resetPassword('badtoken', 'newpassword'),
    ).rejects.toThrow(InvalidTokenException);
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const rawToken = 'c'.repeat(64);
    const record = buildVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.PASSWORD_RESET,
      used_at: null,
      expires_at: new Date(Date.now() - 1000),
      user: buildUser({ id: 'u1', password: 'oldhash' }),
    });
    verificationTokenRepository.findOne.mockResolvedValue(record);

    await expect(
      authService.resetPassword(rawToken, 'newpassword'),
    ).rejects.toThrow(TokenExpiredException);
  });

  it('hashes the new password, marks token used, and revokes refresh tokens', async () => {
    const rawToken = 'd'.repeat(64);
    const user = buildUser({ id: 'u1', password: 'oldhash' });
    const record = buildVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.PASSWORD_RESET,
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
      user,
    });
    verificationTokenRepository.findOne.mockResolvedValue(record);

    const qbMock = createUpdateQueryBuilderMock<RefreshToken>();
    refreshTokenRepository.createQueryBuilder.mockReturnValue(qbMock);

    await authService.resetPassword(rawToken, 'newplaintext');

    expect(record.used_at).toBeInstanceOf(Date);
    expect(user.password).not.toBe('oldhash');
    expect(user.password).toMatch(/^\$argon2/);
    expect(verificationTokenRepository.save.mock.calls[0]).toEqual([record]);
    expect(usersService.save.mock.calls[0]).toEqual([user]);
    expect(qbMock.where.mock.calls[0]).toEqual([
      'user_id = :userId',
      {
        userId: 'u1',
      },
    ]);
    expect(qbMock.execute.mock.calls).toHaveLength(1);
  });
});
