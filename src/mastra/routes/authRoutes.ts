import crypto from 'crypto';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SESSION_COOKIE_NAME = 'walaplus_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

function getRedirectUri(): string {
  const domain = process.env.REPLIT_DOMAINS?.split(',')[0]
    || process.env.REPLIT_DEV_DOMAIN
    || `localhost:5000`;
  const protocol = domain.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${domain}/api/auth/google/callback`;
}

function signSession(payload: Record<string, any>): string {
  const secret = process.env.SESSION_SECRET || 'fallback-dev-secret';
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token: string): Record<string, any> | null {
  try {
    const secret = process.env.SESSION_SECRET || 'fallback-dev-secret';
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getSessionFromCookie(cookieHeader: string | undefined): Record<string, any> | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}

async function initAuthTables(): Promise<void> {
  await pool.query(`
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS picture TEXT;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'local';
  `).catch(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        team VARCHAR(50) NOT NULL DEFAULT 'Other',
        role VARCHAR(50) NOT NULL DEFAULT 'department_viewer',
        status VARCHAR(30) DEFAULT 'active',
        password_hash VARCHAR(255),
        mfa_enabled BOOLEAN DEFAULT FALSE,
        mfa_secret VARCHAR(255),
        invitation_id INTEGER,
        access_reason TEXT,
        approved_by VARCHAR(255),
        approved_at TIMESTAMP,
        denied_by VARCHAR(255),
        denied_at TIMESTAMP,
        denial_reason TEXT,
        last_login_at TIMESTAMP,
        login_count INTEGER DEFAULT 0,
        google_id VARCHAR(255),
        picture TEXT,
        auth_provider VARCHAR(50) DEFAULT 'local',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
  });
}

async function upsertGoogleUser(profile: { sub: string; email: string; name: string; picture: string }) {
  await initAuthTables();

  const existing = await pool.query('SELECT * FROM platform_users WHERE email = $1', [profile.email]);

  if (existing.rows.length > 0) {
    const result = await pool.query(
      `UPDATE platform_users
       SET google_id = $1, full_name = $2, picture = $3, auth_provider = 'google',
           last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
       WHERE email = $4
       RETURNING *`,
      [profile.sub, profile.name, profile.picture, profile.email]
    );
    return result.rows[0];
  } else {
    const result = await pool.query(
      `INSERT INTO platform_users (email, full_name, google_id, picture, auth_provider, team, role, status, mfa_enabled, login_count, last_login_at)
       VALUES ($1, $2, $3, $4, 'google', 'Other', 'department_viewer', 'active', false, 1, NOW())
       RETURNING *`,
      [profile.email, profile.name, profile.sub, profile.picture]
    );
    return result.rows[0];
  }
}

export const authRoutes = [
  {
    path: "/api/auth/google",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        if (!clientId) {
          return c.json({ error: 'Google OAuth not configured' }, 500);
        }

        const state = crypto.randomBytes(16).toString('hex');
        const redirectUri = getRedirectUri();

        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid email profile',
          access_type: 'offline',
          state,
          prompt: 'select_account',
        });

        const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

        const isSecure = !getRedirectUri().startsWith('http://localhost');
        c.header('Set-Cookie', `oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${isSecure ? '; Secure' : ''}`);
        return c.redirect(url);
      };
    },
  },
  {
    path: "/api/auth/google/callback",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            console.error('[Auth] Google OAuth error:', error);
            return c.redirect('/login?error=google_denied');
          }

          if (!code) {
            return c.redirect('/login?error=no_code');
          }

          const cookies = c.req.header('Cookie') || '';
          const stateMatch = cookies.match(/oauth_state=([^;]+)/);
          const storedState = stateMatch ? stateMatch[1] : null;
          if (!storedState || storedState !== returnedState) {
            console.error('[Auth] OAuth state mismatch');
            return c.redirect('/login?error=invalid_state');
          }

          const clientId = process.env.GOOGLE_CLIENT_ID;
          const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
          const redirectUri = getRedirectUri();

          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id: clientId!,
              client_secret: clientSecret!,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
            }),
          });

          const tokenData = await tokenRes.json() as any;

          if (tokenData.error) {
            console.error('[Auth] Token exchange error:', tokenData);
            return c.redirect('/login?error=token_exchange');
          }

          const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });

          const profile = await userInfoRes.json() as any;

          if (!profile.email) {
            console.error('[Auth] No email in profile:', profile);
            return c.redirect('/login?error=no_email');
          }

          const user = await upsertGoogleUser({
            sub: profile.sub,
            email: profile.email,
            name: profile.name || profile.email,
            picture: profile.picture || '',
          });

          const sessionToken = signSession({
            userId: user.id,
            email: user.email,
            name: user.full_name,
            picture: user.picture,
            role: user.role,
            exp: Date.now() + SESSION_MAX_AGE * 1000,
          });

          const isSecure = !getRedirectUri().startsWith('http://localhost');
          const cookieFlags = `HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax${isSecure ? '; Secure' : ''}`;

          c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; ${cookieFlags}`);
          return c.redirect('/');
        } catch (err) {
          console.error('[Auth] Callback error:', err);
          return c.redirect('/login?error=callback_failed');
        }
      };
    },
  },
  {
    path: "/api/auth/me",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header('Cookie'));
        if (!session) {
          return c.json({ authenticated: false }, 401);
        }
        return c.json({
          authenticated: true,
          user: {
            id: session.userId,
            email: session.email,
            name: session.name,
            picture: session.picture,
            role: session.role,
          },
        });
      };
    },
  },
  {
    path: "/api/auth/logout",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const isSecure = !getRedirectUri().startsWith('http://localhost');
        const cookieFlags = `HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isSecure ? '; Secure' : ''}`;
        c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; ${cookieFlags}`);
        return c.json({ success: true });
      };
    },
  },
];
