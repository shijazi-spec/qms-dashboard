/**
 * Tests for redactSensitiveFields and the event-log write path.
 *
 * Run with:  npx jest src/utils/redactSensitiveFields.test.ts
 */

import { redactSensitiveFields, REDACTED_SENTINEL } from './eventLogsDatabase';

/* =========================================================================
 * Unit tests — redactSensitiveFields helper
 * =========================================================================*/

describe('redactSensitiveFields — unit tests', () => {
  it('returns null/undefined unchanged', () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
  });

  it('passes through non-sensitive flat objects untouched', () => {
    const input = { username: 'alice', email: 'alice@example.com', role: 'admin' };
    expect(redactSensitiveFields(input)).toEqual(input);
  });

  it('redacts exact field name: password', () => {
    const result = redactSensitiveFields({ username: 'bob', password: 's3cr3t!', role: 'user' });
    expect(result.password).toBe(REDACTED_SENTINEL);
    expect(result.username).toBe('bob');
  });

  it('redacts exact field name: password_hash', () => {
    const result = redactSensitiveFields({ id: 1, password_hash: '$2b$12$hashedvalue', email: 'x@y.com' });
    expect(result.password_hash).toBe(REDACTED_SENTINEL);
    expect(result.email).toBe('x@y.com');
  });

  it('redacts exact field name: mfa_secret', () => {
    const result = redactSensitiveFields({ mfa_enabled: true, mfa_secret: 'TOTP_BASE32_SECRET' });
    expect(result.mfa_secret).toBe(REDACTED_SENTINEL);
    expect(result.mfa_enabled).toBe(true);
  });

  it('redacts suffix _token fields (e.g. access_token, refresh_token)', () => {
    const result = redactSensitiveFields({
      access_token: 'eyJhbGciOiJIUzI1NiJ9',
      refresh_token: 'rt_xyzabc',
      zoho_refresh_token: 'zoho_rt_secret',
    });
    expect(result.access_token).toBe(REDACTED_SENTINEL);
    expect(result.refresh_token).toBe(REDACTED_SENTINEL);
    expect(result.zoho_refresh_token).toBe(REDACTED_SENTINEL);
  });

  it('redacts suffix _key fields (e.g. api_key, openai_api_key)', () => {
    const result = redactSensitiveFields({ api_key: 'sk-abc123', openai_api_key: 'sk-openai' });
    expect(result.api_key).toBe(REDACTED_SENTINEL);
    expect(result.openai_api_key).toBe(REDACTED_SENTINEL);
  });

  it('redacts suffix _secret fields (e.g. client_secret)', () => {
    const result = redactSensitiveFields({ client_secret: 'cs_live_xyz', client_id: 'cid_123' });
    expect(result.client_secret).toBe(REDACTED_SENTINEL);
    expect(result.client_id).toBe('cid_123');
  });

  it('redacts suffix _hash fields', () => {
    const result = redactSensitiveFields({ value: 'abc', value_hash: 'sha256hex' });
    expect(result.value_hash).toBe(REDACTED_SENTINEL);
    expect(result.value).toBe('abc');
  });

  it('redacts prefix mfa_ fields', () => {
    const result = redactSensitiveFields({ mfa_code: '123456', mfa_token: 'otptoken' });
    expect(result.mfa_code).toBe(REDACTED_SENTINEL);
    expect(result.mfa_token).toBe(REDACTED_SENTINEL);
  });

  it('redacts recursively inside nested objects', () => {
    const result = redactSensitiveFields({
      user: { email: 'a@b.com', password_hash: '$2b$12$xyz', mfa_secret: 'secret' },
      meta: { module: 'auth' },
    });
    expect(result.user.password_hash).toBe(REDACTED_SENTINEL);
    expect(result.user.mfa_secret).toBe(REDACTED_SENTINEL);
    expect(result.user.email).toBe('a@b.com');
    expect(result.meta.module).toBe('auth');
  });

  it('redacts inside arrays', () => {
    const result = redactSensitiveFields([
      { id: 1, password: 'plain' },
      { id: 2, name: 'safe' },
    ]);
    expect(result[0].password).toBe(REDACTED_SENTINEL);
    expect(result[1].name).toBe('safe');
  });

  it('uses fieldName param to redact plain-string values (change_history path)', () => {
    expect(redactSensitiveFields('$2b$12$hashedvalue', 'password_hash')).toBe(REDACTED_SENTINEL);
    expect(redactSensitiveFields('TOTP_BASE32', 'mfa_secret')).toBe(REDACTED_SENTINEL);
    expect(redactSensitiveFields('eyJhb', 'access_token')).toBe(REDACTED_SENTINEL);
  });

  it('does NOT redact safe fieldName values (change_history path)', () => {
    expect(redactSensitiveFields('alice', 'full_name')).toBe('alice');
    expect(redactSensitiveFields('active', 'status')).toBe('active');
  });

  it('password-change scenario: new_value does not leak password or hash', () => {
    const newValue = {
      id: 42,
      email: 'user@example.com',
      full_name: 'Alice Smith',
      role: 'department_viewer',
      password_hash: '$2b$12$realBcryptHash1234567890abcdefghijklmnopqrstuv',
      mfa_secret: null,
      updated_at: '2026-04-24T00:00:00Z',
    };

    const redacted = redactSensitiveFields(newValue);

    expect(redacted.password_hash).toBe(REDACTED_SENTINEL);
    expect(redacted.mfa_secret).toBe(REDACTED_SENTINEL);

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('realBcryptHash');
    expect(serialized).not.toContain('$2b$12$');

    expect(redacted.email).toBe('user@example.com');
    expect(redacted.full_name).toBe('Alice Smith');
  });

  it('is case-insensitive for key matching', () => {
    const result = redactSensitiveFields({ PASSWORD: 'secret', Password_Hash: 'hash', API_KEY: 'key' });
    expect(result.PASSWORD).toBe(REDACTED_SENTINEL);
    expect(result.Password_Hash).toBe(REDACTED_SENTINEL);
    expect(result.API_KEY).toBe(REDACTED_SENTINEL);
  });

  it('correctly handles partially-redacted payloads (additional sensitive keys are still caught)', () => {
    const partiallyRedacted = {
      id: 1,
      password_hash: REDACTED_SENTINEL,
      mfa_secret: 'still_exposed_secret',
      email: 'user@test.com',
    };
    const result = redactSensitiveFields(partiallyRedacted);
    expect(result.password_hash).toBe(REDACTED_SENTINEL);
    expect(result.mfa_secret).toBe(REDACTED_SENTINEL);
    expect(result.email).toBe('user@test.com');
  });
});

/* =========================================================================
 * Integration-style test — logEvent password-change path
 *
 * This test verifies that the actual `logEvent()` write path never persists
 * plaintext passwords or bcrypt hashes into event_logs.  The pg pool is
 * mocked so no real database connection is required.
 * =========================================================================*/

jest.mock('pg', () => {
  const capturedQueries: any[] = [];
  const mockQuery = jest.fn().mockImplementation((sql: string, params: any[]) => {
    capturedQueries.push({ sql, params });
    const fakeRow = {
      id: 1, timestamp: new Date(), action_type: 'UPDATE', entity_type: 'USER',
      ai_involved: false, severity: 'WARNING', created_at: new Date(),
      old_value: params[9] ?? null,
      new_value: params[10] ?? null,
    };
    return Promise.resolve({ rows: [fakeRow], rowCount: 1 });
  });
  const MockPool = jest.fn().mockImplementation(() => ({ query: mockQuery }));
  (MockPool as any)._capturedQueries = capturedQueries;
  (MockPool as any)._mockQuery = mockQuery;
  return { Pool: MockPool };
});

describe('logEvent — password-change write path integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not persist plaintext password or bcrypt hash in event_logs.new_value', async () => {
    const { logEvent } = await import('./eventLogsDatabase');
    const pg = await import('pg');
    const mockQuery = (pg.Pool as any)._mockQuery as jest.Mock;

    const BCRYPT_HASH = '$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ';
    const PLAIN_PASSWORD = 'MyS3cretP@ssword!';

    await logEvent({
      actionType: 'UPDATE',
      entityType: 'USER',
      entityId: '42',
      entityName: 'Alice Smith',
      description: 'User password updated',
      severity: 'WARNING',
      module: 'auth',
      oldValue: {
        id: 42,
        email: 'alice@example.com',
        full_name: 'Alice Smith',
        password_hash: BCRYPT_HASH,
        mfa_secret: 'JBSWY3DPEHPK3PXP',
        role: 'department_viewer',
      },
      newValue: {
        id: 42,
        email: 'alice@example.com',
        full_name: 'Alice Smith',
        password_hash: BCRYPT_HASH,
        mfa_secret: 'JBSWY3DPEHPK3PXP',
        role: 'department_viewer',
        updated_at: '2026-04-24T00:00:00Z',
      },
    }).catch(() => {});

    expect(mockQuery).toHaveBeenCalled();
    const callArgs = mockQuery.mock.calls[0];
    const params: any[] = callArgs[1];

    const oldValueJson: string | null = params[9];
    const newValueJson: string | null = params[10];

    if (oldValueJson) {
      expect(oldValueJson).not.toContain(BCRYPT_HASH);
      expect(oldValueJson).not.toContain('$2b$12$');
      expect(oldValueJson).not.toContain(PLAIN_PASSWORD);
      expect(oldValueJson).not.toContain('JBSWY3DPEHPK3PXP');
      expect(oldValueJson).toContain(REDACTED_SENTINEL);
    }

    if (newValueJson) {
      expect(newValueJson).not.toContain(BCRYPT_HASH);
      expect(newValueJson).not.toContain('$2b$12$');
      expect(newValueJson).not.toContain(PLAIN_PASSWORD);
      expect(newValueJson).not.toContain('JBSWY3DPEHPK3PXP');
      expect(newValueJson).toContain(REDACTED_SENTINEL);
    }
  });
});
