export const vendorRoutes = [
  {
    path: "/api/vendors",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllVendors, initVendorTables } = await import('../../utils/vendorDatabase');
          await initVendorTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const criticality = url.searchParams.get('criticality') || undefined;
          const category = url.searchParams.get('category') || undefined;
          const search = url.searchParams.get('search') || undefined;

          logger?.info('📋 [VendorAPI] GET /api/vendors');
          const result = await getAllVendors({ status, criticality, category, search });
          return c.json(result);
        } catch (error) {
          console.error('❌ [VendorAPI] Error fetching vendors:', error);
          return c.json({ error: 'Failed to fetch vendors' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getVendorSummary, initVendorTables } = await import('../../utils/vendorDatabase');
          await initVendorTables();
          
          logger?.info('📊 [VendorAPI] GET /api/vendors/summary');
          const summary = await getVendorSummary();
          return c.json(summary);
        } catch (error) {
          console.error('❌ [VendorAPI] Error fetching summary:', error);
          return c.json({ error: 'Failed to fetch vendor summary' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getVendorById, getAssessmentsByVendor, getRemediationsByVendor, initVendorTables } = await import('../../utils/vendorDatabase');
          await initVendorTables();
          
          const id = parseInt(c.req.param('id'));
          logger?.info('📋 [VendorAPI] GET /api/vendors/:id', { id });

          const vendor = await getVendorById(id);
          if (!vendor) {
            return c.json({ error: 'Vendor not found' }, 404);
          }

          const [assessments, remediations] = await Promise.all([
            getAssessmentsByVendor(id),
            getRemediationsByVendor(id)
          ]);

          return c.json({ vendor, assessments, remediations });
        } catch (error) {
          console.error('❌ [VendorAPI] Error fetching vendor:', error);
          return c.json({ error: 'Failed to fetch vendor' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createVendor, initVendorTables } = await import('../../utils/vendorDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initVendorTables();
          
          const body = await c.req.json();
          logger?.info('📝 [VendorAPI] POST /api/vendors', { name: body.name, by: sessionUser.email });

          if (!body.vendor_code || !body.name || !body.category) {
            return c.json({ error: 'Missing required fields: vendor_code, name, category' }, 400);
          }

          const vendor = await createVendor({ ...body, created_by: sessionUser.email });

          await logEvent({
            entityType: 'VENDOR',
            entityId: vendor.id!.toString(),
            actionType: 'CREATE',
            description: `New vendor registered: ${vendor.name}`,
            newValue: JSON.stringify(vendor),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'vendor_risk'
          });

          return c.json({ success: true, vendor });
        } catch (error: any) {
          console.error('❌ [VendorAPI] Error creating vendor:', error);
          if (error.code === '23505') {
            return c.json({ error: 'Vendor code already exists' }, 400);
          }
          return c.json({ error: 'Failed to create vendor' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateVendor, getVendorById, initVendorTables } = await import('../../utils/vendorDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initVendorTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [VendorAPI] PUT /api/vendors/:id', { id, by: sessionUser.email });

          const existing = await getVendorById(id);
          if (!existing) {
            return c.json({ error: 'Vendor not found' }, 404);
          }

          const vendor = await updateVendor(id, body);

          await logEvent({
            entityType: 'VENDOR',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Vendor updated: ${vendor.name}`,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(vendor),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'vendor_risk'
          });

          return c.json({ success: true, vendor });
        } catch (error) {
          console.error('❌ [VendorAPI] Error updating vendor:', error);
          return c.json({ error: 'Failed to update vendor' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/assessments",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createAssessment, getVendorById, initVendorTables } = await import('../../utils/vendorDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initVendorTables();
          
          const body = await c.req.json();
          logger?.info('📝 [VendorAPI] POST /api/vendors/assessments', { by: sessionUser.email });

          if (!body.vendor_id || !body.assessment_type) {
            return c.json({ error: 'Missing required fields: vendor_id, assessment_type' }, 400);
          }

          const vendor = await getVendorById(body.vendor_id);
          if (!vendor) {
            return c.json({ error: 'Vendor not found' }, 404);
          }

          const assessment = await createAssessment({ ...body, assessed_by: sessionUser.email });

          await logEvent({
            entityType: 'ASSESSMENT',
            entityId: assessment.id!.toString(),
            actionType: 'CREATE',
            description: `Vendor assessment completed for ${vendor.name}: ${assessment.risk_level} risk`,
            newValue: JSON.stringify(assessment),
            userName: sessionUser.email,
            severity: assessment.risk_level === 'critical' ? 'CRITICAL' : 'INFO',
            module: 'vendor_risk'
          });

          return c.json({ success: true, assessment });
        } catch (error) {
          console.error('❌ [VendorAPI] Error creating assessment:', error);
          return c.json({ error: 'Failed to create assessment' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/remediations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllRemediations, initVendorTables } = await import('../../utils/vendorDatabase');
          await initVendorTables();
          
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status') || undefined;
          const priority = url.searchParams.get('priority') || undefined;

          logger?.info('📋 [VendorAPI] GET /api/vendors/remediations');
          const result = await getAllRemediations({ status, priority });
          return c.json(result);
        } catch (error) {
          console.error('❌ [VendorAPI] Error fetching remediations:', error);
          return c.json({ error: 'Failed to fetch remediations' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/remediations",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createRemediation, getVendorById, initVendorTables } = await import('../../utils/vendorDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initVendorTables();
          
          const body = await c.req.json();
          logger?.info('📝 [VendorAPI] POST /api/vendors/remediations', { by: sessionUser.email });

          if (!body.vendor_id || !body.title || !body.description || !body.priority || !body.category) {
            return c.json({ error: 'Missing required fields: vendor_id, title, description, priority, category' }, 400);
          }

          const vendor = await getVendorById(body.vendor_id);
          if (!vendor) {
            return c.json({ error: 'Vendor not found' }, 404);
          }

          const remediation = await createRemediation({ ...body, created_by: sessionUser.email });

          await logEvent({
            entityType: 'REMEDIATION',
            entityId: remediation.id!.toString(),
            actionType: 'CREATE',
            description: `Vendor remediation created for ${vendor.name}: ${remediation.title}`,
            newValue: JSON.stringify(remediation),
            userName: sessionUser.email,
            severity: remediation.priority === 'critical' ? 'CRITICAL' : 'INFO',
            module: 'vendor_risk'
          });

          return c.json({ success: true, remediation });
        } catch (error) {
          console.error('❌ [VendorAPI] Error creating remediation:', error);
          return c.json({ error: 'Failed to create remediation' }, 500);
        }
      };
    }
  },
  {
    path: "/api/vendors/remediations/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateRemediation, initVendorTables } = await import('../../utils/vendorDatabase');
          const { logEvent } = await import('../../utils/eventLogsDatabase');
          await initVendorTables();
          
          const id = parseInt(c.req.param('id'));
          const body = await c.req.json();
          logger?.info('📝 [VendorAPI] PUT /api/vendors/remediations/:id', { id, by: sessionUser.email });

          const remediation = await updateRemediation(id, body);

          await logEvent({
            entityType: 'REMEDIATION',
            entityId: id.toString(),
            actionType: 'UPDATE',
            description: `Vendor remediation updated: ${remediation.title}`,
            newValue: JSON.stringify(remediation),
            userName: sessionUser.email,
            severity: 'INFO',
            module: 'vendor_risk'
          });

          return c.json({ success: true, remediation });
        } catch (error) {
          console.error('❌ [VendorAPI] Error updating remediation:', error);
          return c.json({ error: 'Failed to update remediation' }, 500);
        }
      };
    }
  }
];
