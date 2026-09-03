import {
  requireRoleOrKey,
  unauthorizedResponse,
} from '../../utils/rbacMiddleware';
import {
  getCRMProviderActivitiesForRecord,
  type ParentModule,
} from '../../utils/CRMProviderActivitiesReader';
import { logger } from '../../utils/logger';

const ACTIVITIES_READ_ROLES = [
  'admin',
  'grc_manager',
  'ai_specialist',
  'head_of_operations_quality',
  'quality_manager',
  'bu_owner',
  'executive',
] as const;

function normalizeModule(raw: string | undefined): ParentModule | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'lead' || v === 'leads') return 'Leads';
  if (v === 'deal' || v === 'deals') return 'Deals';
  return null;
}

export const CRMProviderActivitiesRoutes = [
  {
    path: '/api/CRMProvider/activities/:module/:recordId',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...ACTIVITIES_READ_ROLES]);
          if (!user) return unauthorizedResponse(c);

          const moduleParam = c.req.param('module');
          const recordId = c.req.param('recordId');

          const parentModule = normalizeModule(moduleParam);
          if (!parentModule) {
            return c.json(
              {
                error:
                  'Invalid module. Use "Leads" or "Deals".',
              },
              400,
            );
          }
          if (!recordId || !/^[0-9]+$/.test(recordId)) {
            return c.json(
              { error: 'Invalid recordId. Expected numeric CRMProvider ID.' },
              400,
            );
          }

          const result = await getCRMProviderActivitiesForRecord(
            parentModule,
            recordId,
          );
          return c.json(result);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Unknown error';
          logger.error(
            `[CRMProviderActivitiesRoutes] Failed to read activities: ${message}`,
          );
          return c.json(
            { error: 'Failed to load activities', detail: message },
            500,
          );
        }
      };
    },
  },
];
