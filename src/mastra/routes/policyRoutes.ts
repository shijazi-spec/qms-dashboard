export const policyRoutes = [
  {
    path: "/api/policies",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllPolicies, initPolicyTables } = await import('../../utils/policyDatabase');
          await initPolicyTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const category = url.searchParams.get('category') || undefined;
          const owner_department = url.searchParams.get('owner_department') || undefined;
          const search = url.searchParams.get('search') || undefined;
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');

          logger?.info('📋 [PolicyAPI] GET /api/policies', { status, category });

          const result = await getAllPolicies({
            status, category, owner_department, search, limit, offset
          });

          return c.json(result);
        } catch (error) {
          console.error('❌ [PolicyAPI] Error fetching policies:', error);
          return c.json({ error: 'Failed to fetch policies' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getPolicySummaryStats, initPolicyTables } = await import('../../utils/policyDatabase');
          await initPolicyTables();
          
          logger?.info('📊 [PolicyAPI] GET /api/policies/summary');
          const summary = await getPolicySummaryStats();
          return c.json(summary);
        } catch (error) {
          console.error('❌ [PolicyAPI] Error fetching summary:', error);
          return c.json({ error: 'Failed to fetch policy summary' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/overdue",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getOverduePolicies, initPolicyTables } = await import('../../utils/policyDatabase');
          await initPolicyTables();
          
          logger?.info('📋 [PolicyAPI] GET /api/policies/overdue');
          const policies = await getOverduePolicies();
          return c.json({ policies });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error fetching overdue policies:', error);
          return c.json({ error: 'Failed to fetch overdue policies' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getPolicyById, getPolicyVersions, getPolicyAcknowledgments, getAcknowledgmentStats, initPolicyTables } = await import('../../utils/policyDatabase');
          await initPolicyTables();
          
          const id = parseInt(c.req.param('id'));
          logger?.info('📋 [PolicyAPI] GET /api/policies/:id', { id });

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          const [versions, acknowledgments, ackStats] = await Promise.all([
            getPolicyVersions(id),
            getPolicyAcknowledgments(id),
            getAcknowledgmentStats(id)
          ]);

          return c.json({ 
            policy, 
            versions,
            acknowledgments,
            acknowledgment_stats: ackStats
          });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error fetching policy:', error);
          return c.json({ error: 'Failed to fetch policy' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createPolicy, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initPolicyTables();
          
          const body = await c.req.json();
          logger?.info('📝 [PolicyAPI] POST /api/policies', { title: body.title, by: sessionUser.email });

          if (!body.policy_number || !body.title || !body.category) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const policy = await createPolicy({ ...body, created_by: sessionUser.email });

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: policy.id!.toString(),
            actionType: 'CREATE',
            description: `New policy created: ${policy.title} (${policy.policy_number})`,
            newValue: JSON.stringify(policy),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy created', { id: policy.id });
          return c.json({ success: true, policy });
        } catch (error: any) {
          console.error('❌ [PolicyAPI] Error creating policy:', error);
          if (error.code === '23505') {
            return c.json({ error: 'Policy number already exists' }, 400);
          }
          return c.json({ error: 'Failed to create policy' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updatePolicy, getPolicyById, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initPolicyTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [PolicyAPI] PUT /api/policies/:id', { id, by: sessionUser.email });

          const existingPolicy = await getPolicyById(id);
          if (!existingPolicy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          if (body.status && body.status !== existingPolicy.status) {
            return c.json({ error: 'Status changes are not allowed via generic update. Use the dedicated /transition endpoint for policy lifecycle changes.' }, 400);
          }
          const { status, ...safeBody } = body;

          const updatedPolicy = await updatePolicy(id, safeBody, sessionUser.email);

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Policy updated: ${updatedPolicy.title}`,
            oldValue: JSON.stringify(existingPolicy),
            newValue: JSON.stringify(updatedPolicy),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy updated', { id });
          return c.json({ success: true, policy: updatedPolicy });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error updating policy:', error);
          return c.json({ error: 'Failed to update policy' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/:id/transition",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { transitionPolicyStatus, getPolicyById, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initPolicyTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [PolicyAPI] POST /api/policies/:id/transition', { id, newStatus: body.new_status, by: sessionUser.email });

          if (!body.new_status) {
            return c.json({ error: 'new_status is required' }, 400);
          }

          if (['published', 'approved'].includes(body.new_status)) {
            const { checkPermission } = await import('../../utils/rbacDatabase');
            const canApprove = await checkPermission(sessionUser.email, 'can_approve_policy');
            if (!canApprove) {
              return forbiddenResponse(c, 'Permission denied: only authorized roles can approve/publish policies');
            }
          }

          const existingPolicy = await getPolicyById(id);
          if (!existingPolicy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          const updatedPolicy = await transitionPolicyStatus(id, body.new_status, sessionUser.email);

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: id.toString(),
            actionType: 'STATUS_CHANGE',
            description: `Policy status changed: ${existingPolicy.status} → ${body.new_status}`,
            oldValue: JSON.stringify({ status: existingPolicy.status }),
            newValue: JSON.stringify({ status: body.new_status }),
            userName: sessionUser.email,
            severity: body.new_status === 'published' ? 'INFO' : 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy status transitioned', { id, newStatus: body.new_status });
          return c.json({ success: true, policy: updatedPolicy });
        } catch (error: any) {
          console.error('❌ [PolicyAPI] Error transitioning policy:', error);
          return c.json({ error: error.message || 'Failed to transition policy' }, 400);
        }
      };
    }
  },
  {
    path: "/api/policies/:id/acknowledge",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { acknowledgePolicy, getPolicyById, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initPolicyTables();
          
          const policyId = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [PolicyAPI] POST /api/policies/:id/acknowledge', { policyId, by: sessionUser.email });

          const policy = await getPolicyById(policyId);
          if (!policy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          const ackData = { ...body, policy_id: policyId, user_name: sessionUser.name, user_email: sessionUser.email };
          const ack = await acknowledgePolicy(ackData);

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: policyId.toString(),
            actionType: 'UPDATE',
            description: `Policy acknowledged by ${sessionUser.name} (${sessionUser.email})`,
            newValue: JSON.stringify(ack),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy acknowledged', { policyId, user: body.user_email });
          return c.json({ success: true, acknowledgment: ack });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error acknowledging policy:', error);
          return c.json({ error: 'Failed to acknowledge policy' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/pending-acknowledgments",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getPendingAcknowledgments, initPolicyTables } = await import('../../utils/policyDatabase');
          await initPolicyTables();
          
          const url = new URL(c.req.url);
          const department = url.searchParams.get('department') || undefined;
          
          logger?.info('📋 [PolicyAPI] GET /api/policies/pending-acknowledgments', { department });
          const policies = await getPendingAcknowledgments(department);
          return c.json({ policies });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error fetching pending acknowledgments:', error);
          return c.json({ error: 'Failed to fetch pending acknowledgments' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/:id/grc-approval",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updatePolicy, getPolicyById, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          const { checkPermission, getUserByEmail, initRbacTables } = await import('../../utils/rbacDatabase');
          await initPolicyTables();
          await initRbacTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          const userEmail = sessionUser.email;
          logger?.info('🔐 [PolicyAPI] POST /api/policies/:id/grc-approval (RBAC enforcement)', { id, userEmail });

          const user = await getUserByEmail(userEmail);
          if (!user) {
            logger?.warn('🚫 [PolicyAPI] Policy approval blocked - user not registered in system', { userEmail });
            await logEvent({
              entityType: 'DOCUMENT',
              entityId: id.toString(),
              actionType: 'UPDATE',
              description: `Policy GRC approval BLOCKED: User ${userEmail} not found in system_users`,
              userName: userEmail,
              severity: 'WARNING',
              module: 'policy_governance'
            });
            return c.json({ 
              error: 'User not found: You must be a registered system user to perform this action'
            }, 403);
          }

          if (!user.is_active) {
            logger?.warn('🚫 [PolicyAPI] Policy approval blocked - user account inactive', { userEmail });
            return c.json({ 
              error: 'Account inactive: Your user account has been deactivated'
            }, 403);
          }

          const hasPermission = await checkPermission(userEmail, 'can_approve_policy');
          if (!hasPermission) {
            logger?.warn('🚫 [PolicyAPI] Policy approval blocked - user lacks GRC permission', { userEmail, userRole: user.role });
            await logEvent({
              entityType: 'DOCUMENT',
              entityId: id.toString(),
              actionType: 'UPDATE',
              description: `Policy GRC approval BLOCKED: User ${userEmail} (role: ${user.role}) lacks GRC Manager permission`,
              userName: userEmail,
              severity: 'WARNING',
              module: 'policy_governance'
            });
            return c.json({ 
              error: `Permission denied: Only GRC Manager or Admin role can approve policies. Your role (${user.role}) does not have this permission.`
            }, 403);
          }

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          if (policy.compliance_approved) {
            return c.json({ 
              error: 'Policy already approved by GRC',
              approved_by: policy.compliance_approved_by,
              approved_at: policy.compliance_approved_at
            }, 400);
          }

          const updatedPolicy = await updatePolicy(id, {
            compliance_approved: true,
            compliance_approved_by: user.name,
            compliance_approved_at: new Date(),
            approval_blocked_reason: undefined
          }, userEmail);

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Policy GRC APPROVED by Compliance Owner: ${policy.title}`,
            oldValue: JSON.stringify({ compliance_approved: false }),
            newValue: JSON.stringify({ compliance_approved: true, compliance_approved_by: user.name }),
            userName: userEmail,
            severity: 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy GRC approved', { id, approvedBy: user.name, role: user.role });
          return c.json({ 
            success: true, 
            policy: updatedPolicy, 
            message: `Policy approved by ${user.name} (${user.role})`,
            approved_by: user.name,
            approved_by_role: user.role
          });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error approving policy:', error);
          return c.json({ error: 'Failed to approve policy' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/:id/set-owners",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { checkPermission } = await import('../../utils/rbacDatabase');
          const canApprove = await checkPermission(sessionUser.email, 'can_approve_policy');
          if (!canApprove) {
            return forbiddenResponse(c, 'Permission denied: only authorized roles can set policy owners');
          }

          const logger = mastra?.getLogger();
          const { updatePolicy, getPolicyById, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initPolicyTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [PolicyAPI] POST /api/policies/:id/set-owners', { id, by: sessionUser.email });

          if (!body.operational_owner || !body.compliance_owner) {
            return c.json({ error: 'Both operational_owner and compliance_owner are required (dual ownership)' }, 400);
          }

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          const updatedPolicy = await updatePolicy(id, {
            operational_owner: body.operational_owner,
            operational_owner_email: body.operational_owner_email,
            compliance_owner: body.compliance_owner,
            compliance_owner_email: body.compliance_owner_email
          }, sessionUser.email);

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Policy dual ownership set: Operational=${body.operational_owner}, Compliance=${body.compliance_owner}`,
            newValue: JSON.stringify({ operational_owner: body.operational_owner, compliance_owner: body.compliance_owner }),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy owners set', { id });
          return c.json({ success: true, policy: updatedPolicy });
        } catch (error) {
          console.error('❌ [PolicyAPI] Error setting policy owners:', error);
          return c.json({ error: 'Failed to set policy owners' }, 500);
        }
      };
    }
  },
  {
    path: "/api/policies/:id/publish",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse, forbiddenResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { checkPermission } = await import('../../utils/rbacDatabase');
          const canApprove = await checkPermission(sessionUser.email, 'can_approve_policy');
          if (!canApprove) {
            return forbiddenResponse(c, 'Permission denied: only authorized roles can publish policies');
          }

          const logger = mastra?.getLogger();
          const { transitionPolicyStatus, getPolicyById, initPolicyTables } = await import('../../utils/policyDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initPolicyTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [PolicyAPI] POST /api/policies/:id/publish (with GRC check)', { id, by: sessionUser.email });

          const policy = await getPolicyById(id);
          if (!policy) {
            return c.json({ error: 'Policy not found' }, 404);
          }

          if (!policy.compliance_approved) {
            logger?.warn('🚫 [PolicyAPI] Policy publish BLOCKED - missing GRC approval', { id });
            await logEvent({
              entityType: 'DOCUMENT',
              entityId: id.toString(),
              actionType: 'UPDATE',
              description: `Policy publish BLOCKED: Missing GRC/Compliance Owner approval for "${policy.title}"`,
              userName: sessionUser.email,
              severity: 'WARNING',
              module: 'policy_governance'
            });
            return c.json({ 
              error: 'Cannot publish: Policy requires GRC Manager (Compliance Owner) approval first',
              compliance_approved: false,
              action_required: 'Request GRC approval before publishing'
            }, 400);
          }

          const updatedPolicy = await transitionPolicyStatus(id, 'published', sessionUser.email);

          await logEvent({
            entityType: 'DOCUMENT',
            entityId: id.toString(),
            actionType: 'STATUS_CHANGE',
            description: `Policy PUBLISHED (after GRC approval): ${policy.title}`,
            oldValue: JSON.stringify({ status: policy.status }),
            newValue: JSON.stringify({ status: 'published' }),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'policy_governance'
          });

          logger?.info('✅ [PolicyAPI] Policy published', { id });
          return c.json({ success: true, policy: updatedPolicy, message: 'Policy published successfully (GRC approval verified)' });
        } catch (error: any) {
          console.error('❌ [PolicyAPI] Error publishing policy:', error);
          return c.json({ error: error.message || 'Failed to publish policy' }, 500);
        }
      };
    }
  }
];
