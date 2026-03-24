import { getSessionFromCookie } from '../mastra/routes/authRoutes';
import { getUserByEmail, checkPermission, type UserRole, type RolePermission } from './rbacDatabase';

export interface SessionUser {
  userId: number;
  email: string;
  name: string;
  role: string;
  picture?: string;
}

export function getSessionUser(c: any): SessionUser | null {
  const session = getSessionFromCookie(c.req.header('Cookie'));
  if (!session) return null;
  return {
    userId: session.userId,
    email: session.email,
    name: session.name,
    role: session.role,
    picture: session.picture,
  };
}

export function requireAuth(c: any): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  return user;
}

export function requireRole(c: any, allowedRoles: UserRole[]): SessionUser | null {
  const user = getSessionUser(c);
  if (!user) return null;
  if (!allowedRoles.includes(user.role as UserRole)) return null;
  return user;
}

export async function requirePermission(
  c: any,
  permission: keyof RolePermission
): Promise<SessionUser | null> {
  const user = getSessionUser(c);
  if (!user) return null;
  const hasPermission = await checkPermission(user.email, permission);
  if (!hasPermission) return null;
  return user;
}

export function unauthorizedResponse(c: any) {
  return c.json({ error: 'Authentication required' }, 401);
}

export function forbiddenResponse(c: any, detail?: string) {
  return c.json({ error: detail || 'Insufficient permissions' }, 403);
}

export function requireAdminOrKey(c: any): SessionUser | null {
  const adminKey = c.req.header('X-Admin-Key');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (expectedKey && adminKey === expectedKey) {
    return { userId: 0, email: 'api-key@system', name: 'API Key Access', role: 'admin' };
  }
  const user = getSessionUser(c);
  if (!user) return null;
  if (user.role !== 'admin') return null;
  return user;
}

export function requireAuthOrKey(c: any): SessionUser | null {
  const adminKey = c.req.header('X-Admin-Key');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (expectedKey && adminKey === expectedKey) {
    return { userId: 0, email: 'api-key@system', name: 'API Key Access', role: 'admin' };
  }
  return getSessionUser(c);
}
