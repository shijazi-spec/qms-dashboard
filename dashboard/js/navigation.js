/**
 * WalaPlus Unified Navigation Component
 * Enterprise-grade grouped dropdown navigation for scalability
 * v4.6: Arabic/RTL support via WalaPlusI18n
 */

// Capture this script's CSP nonce while document.currentScript is still set,
// so dynamically created <style>/<script> tags can be authorized under the
// strict style-src/script-src 'nonce-...' policy.
const WALAPLUS_NAV_NONCE = (document.currentScript && document.currentScript.nonce) || '';

// Helper: load i18n module before navigation renders.
// Falls back gracefully if i18n.js is not yet loaded.
(function loadI18nIfNeeded() {
  if (window.WalaPlusI18n) return;
  var script = document.createElement('script');
  script.src = '/js/i18n.js?v=1.0';
  script.async = false;
  if (WALAPLUS_NAV_NONCE) script.setAttribute('nonce', WALAPLUS_NAV_NONCE);
  document.head.appendChild(script);
})();

const WalaPlusNav = {
  currentPage: '',

  // Short-circuit translation helper — falls back to a Title Case rendering
  // of the key fragment when the i18n bundle hasn't loaded or the key is
  // missing, so users never see raw fragments like "qms-docs" leaking
  // through to the rail. The underlying lookup also returns the last
  // fragment for missing keys, so we detect that case and prettify it.
  _t(key) {
    var last = key.split('.').pop();
    if (window.WalaPlusI18n && window.WalaPlusI18n.t) {
      var val = window.WalaPlusI18n.t(key);
      if (val === last && key.indexOf('.') !== -1) return this._titleCase(last);
      return val;
    }
    return this._titleCase(last);
  },

  _titleCase(s) {
    return String(s)
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  },

  // Static lookups for nav group/item labels. Each known id maps to a literal
  // translation call (one per case branch) so the i18n guardrail can
  // statically verify every key resolves in en.json + ar.json.
  _navGroupLabel(id) {
    switch (id) {
      case 'quality':   return this._t('nav.groups.quality');
      case 'grc':       return this._t('nav.groups.grc');
      case 'fraud':     return this._t('nav.groups.fraud');
      case 'analytics': return this._t('nav.groups.analytics');
      case 'value':     return this._t('nav.groups.value');
      case 'support':   return this._t('nav.groups.support');
      case 'admin':     return this._t('nav.groups.admin');
      case 'tools':     return this._t('nav.groups.tools');
      case 'triggers':  return this._t('nav.groups.triggers');
    }
    return '';
  },
  _navItemLabel(id) {
    switch (id) {
      case 'dashboard':       return this._t('nav.items.dashboard');
      case 'crm':             return this._t('nav.items.crm');
      case 'audits':          return this._t('nav.items.audits');
      case 'calls':           return this._t('nav.items.calls');
      case 'duplicates':      return this._t('nav.items.duplicates');
      case 'qms':             return this._t('nav.items.qms');
      case 'grc':             return this._t('nav.items.grc');
      case 'tablef':          return this._t('nav.items.tablef');
      case 'risks':           return this._t('nav.items.risks');
      case 'qms-docs':        return this._t('nav.items.qms-docs');
      case 'compliance':      return this._t('nav.items.compliance');
      case 'external-audits': return this._t('nav.items.external-audits');
      case 'vendors':         return this._t('nav.items.vendors');
      case 'reviews':         return this._t('nav.items.reviews');
      case 'kpis':            return this._t('nav.items.kpis');
      case 'executive':       return this._t('nav.items.executive');
      case 'team':            return this._t('nav.items.team');
      case 'fraud-rules':     return this._t('nav.items.fraud-rules');
      case 'fraud-incidents': return this._t('nav.items.fraud-incidents');
      case 'fraud-dashboard': return this._t('nav.items.fraud-dashboard');
      case 'fraud-country-risk': return this._t('nav.items.fraud-country-risk');
      case 'triggers':        return this._t('nav.items.triggers');
      case 'roi':             return this._t('nav.items.roi');
      case 'projects':        return this._t('nav.items.projects');
      case 'consultant':      return this._t('nav.items.consultant');
      case 'guide':           return this._t('nav.items.guide');
      case 'onboarding':      return this._t('nav.items.onboarding');
      case 'feedback':        return this._t('nav.items.feedback');
      case 'scope':           return this._t('nav.items.scope');
      case 'migration':       return this._t('nav.items.migration');
      case 'admin':           return this._t('nav.items.admin');
      case 'users':           return this._t('nav.items.users');
      case 'ai-approvals':    return this._t('nav.items.ai-approvals');
      case 'infographic':     return this._t('nav.items.infographic');
      case 'logs':            return this._t('nav.items.logs');
      case 'health':          return this._t('nav.items.health');
    }
    return '';
  },

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  navigationGroups: [
    {
      id: 'quality',
      label: 'Quality',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      color: 'blue',
      items: [
        { label: 'Dashboard', href: '/', icon: 'chart-bar', id: 'dashboard' },
        { label: 'Internal Audits', href: '/audits', icon: 'clipboard-check', id: 'audits' },
        { label: 'Call Evaluation', href: '/calls', icon: 'phone', id: 'calls' },
        { label: 'Duplicates Radar', href: '/duplicates', icon: 'duplicate', id: 'duplicates' },
        // Audit Reports: this is the existing Integrated QMS dashboard
        // (URL kept as /qms for backward compatibility) — the page houses
        // CAPA / Nonconformance / coaching workflows so it lives under
        // Quality alongside the operator's day-to-day audit tools.
        { label: 'Audit Reports', href: '/qms', icon: 'shield-check', id: 'qms' }
      ]
    },
    {
      id: 'grc',
      label: 'GRC',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
      color: 'teal',
      items: [
        { label: 'Control Tower', href: '/grc', icon: 'shield-check', id: 'grc' },
        { label: 'Table F', href: '/tablef', icon: 'table', id: 'tablef' },
        { label: 'Risk Mgmt', href: '/risks', icon: 'exclamation-triangle', id: 'risks' },
        // QMS document library — categorised upload boxes for Documents,
        // Policies, Forms, Security Controls and SOPs. Files uploaded here
        // are staged for future mapping to the regulations tracked in the
        // Compliance module (PDPL, ISO 9001, ISO 27001, PCI DSS, …).
        { label: 'Documents Library', href: '/qms-docs', icon: 'document-text', id: 'qms-docs' },
        { label: 'Compliance', href: '/compliance', icon: 'check-circle', id: 'compliance' },
        // Compliance v2 — Audit Readiness lives between Compliance and
        // Document Mapping so the GRC user sees the full lifecycle in
        // order: define obligations -> run audits -> link evidence.
        { label: 'Audit Readiness', href: '/audit-readiness', icon: 'clipboard-check', id: 'audit-readiness' },
        // Document Mapping: AI-assisted workspace for mapping uploaded
        // documents to compliance clauses. Coverage tiles, suggest console,
        // AI-judged findings, and audit-readiness PDFs live here so the
        // Compliance page stays focused on governance/assessment workflow.
        { label: 'Document Mapping', href: '/document-mapping', icon: 'duplicate', id: 'document-mapping' },
        { label: 'External Audits', href: '/external-audits', icon: 'clipboard-check', id: 'external-audits' },
        { label: 'Vendors', href: '/vendors', icon: 'users', id: 'vendors' },
        { label: 'Mgmt Review', href: '/reviews', icon: 'clipboard-list', id: 'reviews' },
        // Trigger Alerts: previously a stray standalone group at the bottom
        // of the rail. Folded into GRC because the alert queue is governance/
        // executive-read scoped (matches the rest of this group's audience)
        // and gives operators one fewer top-level section to scan past.
        { label: 'Trigger Alerts', href: '/triggers', icon: 'exclamation-triangle', id: 'triggers' }
      ]
    },
    {
      // Fraud Management Module (PRD-FRD-001) — surfaced as its own
      // top-level sidebar section directly under GRC. Items were
      // previously listed inside GRC; moved here per user request so
      // fraud workflows have a dedicated home.
      id: 'fraud',
      label: 'Fraud Module',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
      color: 'red',
      items: [
        { label: 'Fraud Rules', href: '/fraud-rules', icon: 'shield-check', id: 'fraud-rules' },
        { label: 'Fraud Incidents', href: '/fraud-incidents', icon: 'exclamation-triangle', id: 'fraud-incidents' },
        { label: 'Fraud KPIs', href: '/fraud-dashboard', icon: 'chart-bar', id: 'fraud-dashboard' },
        { label: 'Country Risk', href: '/fraud-country-risk', icon: 'globe', id: 'fraud-country-risk' }
      ]
    },
    {
      id: 'analytics',
      label: 'Team Mgmt',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
      color: 'amber',
      items: [
        { label: 'KPIs', href: '/kpis', icon: 'chart-bar', id: 'kpis' },
        { label: 'Board Dashboard', href: '/executive', icon: 'office-building', id: 'executive' },
        { label: 'Team Performance', href: '/team', icon: 'user-group', id: 'team' },
        // AI Approvals Queue lives under Team Mgmt per user request — it is
        // a people/queue management surface (approvers reviewing pending AI
        // actions) rather than a platform-admin tool. Item-level requiresRole
        // keeps it visible only to the same admin-tier audience as before.
        { label: 'AI Approvals Queue', href: '/ai-approvals', icon: 'check-circle', id: 'ai-approvals', requiresRole: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist'] }
      ]
    },
    {
      id: 'value',
      label: 'Value',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      color: 'green',
      items: [
        { label: 'ROI & NPV', href: '/roi', icon: 'currency-dollar', id: 'roi' },
        { label: 'Projects', href: '/projects', icon: 'folder', id: 'projects' }
      ]
    },
    {
      // Tools: cross-cutting operator utilities that are not strictly admin-
      // only. AI Consultant lives here (now open to all roles) alongside the
      // data-migration and infographic generators.
      id: 'tools',
      label: 'Tools',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>`,
      color: 'teal',
      items: [
        // AI Consultant pinned to the top of Tools per user request — it is
        // the most-used item in this group and is open to all roles.
        { label: 'AI Consultant', href: '/consultant', icon: 'brain', id: 'consultant' },
        { label: 'Data Migration Engine', href: '/migration', icon: 'database', id: 'migration', requiresRole: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist'] },
        { label: 'Infographic Generator', href: '/infographic', icon: 'document', id: 'infographic', requiresRole: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist'] }
      ]
    },
    {
      // Admin Permission: platform-wide administrative controls. Gated by
      // role at render time so non-admins never see this group.
      id: 'admin',
      label: 'Admin Permission',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
      color: 'slate',
      requiresRole: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist'],
      items: [
        // Merged entry: previously "User & Role Management" (/admin) and
        // "Users & Access" (/users) were two separate links. Both pages
        // still exist; this single link points to /users (Users & Access
        // Control — has Invite User / Delete User / status + role display),
        // which is the actively-used surface for onboarding team members.
        // The legacy /admin page remains URL-reachable for role-config
        // workflows until the two pages are fully merged at the HTML level.
        { label: 'User Access & Role Management', href: '/users', icon: 'users', id: 'user-access' },
        { label: 'System Logs', href: '/logs', icon: 'document-report', id: 'logs' },
        { label: 'Health Pulse', href: '/dashboard/health', icon: 'shield-check', id: 'health' }
      ]
    },
    {
      id: 'support',
      label: 'Support',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      color: 'purple',
      items: [
        { label: 'User Guide', href: '/guide', icon: 'book-open', id: 'guide' },
        { label: 'Give Feedback', href: '/feedback', icon: 'chat-alt', id: 'feedback' },
        { label: 'Scope of Work', href: '/docs/SCOPE_OF_WORK.html', icon: 'document', id: 'scope', external: true },
        // Help moved to the end of Support per user request — it is the
        // generic onboarding/help page and acts as a fallback after the
        // more specific items above.
        { label: 'Help', href: '/onboarding', icon: 'question-mark-circle', id: 'onboarding' }
      ]
    }
  ],

  getColorClasses(color) {
    const colors = {
      blue: { bg: 'bg-blue-600', hover: 'hover:bg-blue-700', text: 'text-blue-600', lightBg: 'bg-blue-50' },
      slate: { bg: 'bg-slate-700', hover: 'hover:bg-slate-800', text: 'text-slate-700', lightBg: 'bg-slate-50' },
      amber: { bg: 'bg-amber-700', hover: 'hover:bg-amber-800', text: 'text-amber-800', lightBg: 'bg-amber-50' },
      green: { bg: 'bg-green-600', hover: 'hover:bg-green-700', text: 'text-green-600', lightBg: 'bg-green-50' },
      purple: { bg: 'bg-purple-600', hover: 'hover:bg-purple-700', text: 'text-purple-600', lightBg: 'bg-purple-50' },
      teal: { bg: 'bg-teal-600', hover: 'hover:bg-teal-700', text: 'text-teal-600', lightBg: 'bg-teal-50' },
      red: { bg: 'bg-red-600', hover: 'hover:bg-red-700', text: 'text-red-600', lightBg: 'bg-red-50' }
    };
    return colors[color] || colors.blue;
  },

  getItemIcon(iconName) {
    const icons = {
      'chart-bar': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
      'shield-check': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
      'table': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`,
      'clipboard-check': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/></svg>`,
      'phone': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>`,
      'beaker': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/></svg>`,
      'exclamation-triangle': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
      'document-text': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
      'check-circle': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      'users': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>`,
      'database': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg>`,
      'duplicate': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>`,
      'office-building': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>`,
      'document-report': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`,
      'currency-dollar': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      'user-group': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>`,
      'folder': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>`,
      'book-open': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>`,
      'question-mark-circle': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      'cog': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
      'document': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>`,
      'brain': `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>`
    };
    return icons[iconName] || icons['document'];
  },

  // ---- Pin / Recent state (per-user via localStorage) -----------------
  // Storage keys are namespaced by the authenticated user id (or :anon
  // when no session is established). The base prefixes below are the
  // values the spec calls out; the suffix is appended in `_pinKey()` /
  // `_recentKey()` so a shared browser never lets one account's pinned/
  // recent state leak into another account's session.
  PIN_KEY_BASE: 'walaplus-nav-pinned',
  RECENT_KEY_BASE: 'walaplus-nav-recent',
  RECENT_MAX: 5,
  _userId: null,

  _userScope() { return this._userId ? ('user:' + this._userId) : 'anon'; },
  _pinKey()    { return this.PIN_KEY_BASE + ':' + this._userScope(); },
  _recentKey() { return this.RECENT_KEY_BASE + ':' + this._userScope(); },

  _readJsonArray(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(function (v) { return typeof v === 'string'; }) : [];
    } catch (_) { return []; }
  },
  _writeJsonArray(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) {}
  },
  loadPinned()  { return this._readJsonArray(this._pinKey()); },
  loadRecent()  { return this._readJsonArray(this._recentKey()); },
  savePinned(a) { this._writeJsonArray(this._pinKey(), a); },
  saveRecent(a) { this._writeJsonArray(this._recentKey(), a); },

  // One-shot migration: if the legacy un-namespaced keys exist (from an
  // earlier build of this rail), copy their contents under the current
  // user's scope on first sight, then clear the legacy values so two
  // accounts on the same browser never see each other's history.
  _migrateLegacyState() {
    if (this._migratedLegacy) return;
    this._migratedLegacy = true;
    try {
      var legacyPin = localStorage.getItem(this.PIN_KEY_BASE);
      var legacyRecent = localStorage.getItem(this.RECENT_KEY_BASE);
      if (legacyPin && !localStorage.getItem(this._pinKey())) {
        localStorage.setItem(this._pinKey(), legacyPin);
      }
      if (legacyRecent && !localStorage.getItem(this._recentKey())) {
        localStorage.setItem(this._recentKey(), legacyRecent);
      }
      if (legacyPin) localStorage.removeItem(this.PIN_KEY_BASE);
      if (legacyRecent) localStorage.removeItem(this.RECENT_KEY_BASE);
    } catch (_) {}
  },

  // Build a lookup of every leaf item across all groups so Pinned/Recent
  // can resolve an itemId back to its label / href / icon / color. Items
  // that belong to a role-restricted group the current user can't see are
  // dropped so they never leak into the Pinned/Recent projections (RBAC).
  _buildItemIndex() {
    var self = this;
    var idx = {};
    this.navigationGroups.forEach(function (group) {
      if (!self._canSeeGroup(group)) return;
      group.items.forEach(function (item) {
        if (!self._canSeeItem(item)) return;
        idx[item.id] = { item: item, group: group };
      });
    });
    return idx;
  },

  // RBAC: a group is visible if it has no requiresRole gate, OR the
  // current user's role intersects the gate. Until /api/auth/me has
  // resolved (loadUserInfo sets _userRole), we render conservatively —
  // gated groups stay hidden so admin-only items never flash for non-
  // admin users on first paint. The unauthenticated/loading rail always
  // shows the open-to-everyone groups.
  _canSeeGroup(group) {
    if (!group || !Array.isArray(group.requiresRole) || !group.requiresRole.length) return true;
    var role = this._userRole;
    if (!role) return false;
    return group.requiresRole.indexOf(role) !== -1;
  },

  // RBAC: an individual item may carry its own requiresRole gate (used
  // when an item lives inside an ungated group — e.g. "Users & Access"
  // under Support). Same conservative behaviour as _canSeeGroup: hide
  // until the role is known.
  _canSeeItem(item) {
    if (!item || !Array.isArray(item.requiresRole) || !item.requiresRole.length) return true;
    var role = this._userRole;
    if (!role) return false;
    return item.requiresRole.indexOf(role) !== -1;
  },

  togglePin(itemId) {
    if (!itemId) return;
    var pinned = this.loadPinned();
    var i = pinned.indexOf(itemId);
    if (i === -1) pinned.push(itemId);
    else pinned.splice(i, 1);
    this.savePinned(pinned);
    // Re-render the rail in place so the Pinned section updates and the
    // pin button on the leaf item swaps icon. bindEvents() is idempotent
    // for the static handlers so we re-bind everything.
    this.render();
    this.bindEvents();
    this.loadUserInfo();
  },

  recordVisit(itemId) {
    if (!itemId) return;
    var recent = this.loadRecent().filter(function (id) { return id !== itemId; });
    recent.unshift(itemId);
    if (recent.length > this.RECENT_MAX) recent.length = this.RECENT_MAX;
    this.saveRecent(recent);
  },

  // ─── Theme (light / dark) ──────────────────────────────────────────────
  // Stored as 'walaplus_theme' = 'light' | 'dark'. Applied to <html> via the
  // `wp-dark` class so CSS overrides in navigation.css can target it. We
  // apply BEFORE render() to avoid a light-to-dark flash on every nav repaint.
  _themeKey: 'walaplus_theme',
  loadTheme() {
    try {
      const v = localStorage.getItem(this._themeKey);
      return v === 'dark' ? 'dark' : 'light';
    } catch { return 'light'; }
  },
  applyTheme(mode) {
    const html = document.documentElement;
    if (mode === 'dark') html.classList.add('wp-dark');
    else html.classList.remove('wp-dark');
    // Swap icon visibility on the toggle button (if rendered)
    const btn = document.getElementById('wp-theme-toggle');
    if (btn) {
      const lightIcon = btn.querySelector('.wp-theme-icon-light');
      const darkIcon  = btn.querySelector('.wp-theme-icon-dark');
      if (lightIcon && darkIcon) {
        if (mode === 'dark') {
          lightIcon.classList.add('hidden');
          darkIcon.classList.remove('hidden');
          btn.setAttribute('aria-label', 'Switch to light mode');
          btn.setAttribute('title', 'Switch to light mode');
        } else {
          lightIcon.classList.remove('hidden');
          darkIcon.classList.add('hidden');
          btn.setAttribute('aria-label', 'Switch to dark mode');
          btn.setAttribute('title', 'Switch to dark mode');
        }
      }
    }
  },
  toggleTheme() {
    const next = this.loadTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(this._themeKey, next); } catch {}
    this.applyTheme(next);
  },

  /**
   * Detect which deployment we're on so the header can flag standby
   * vs primary at a glance — important now that we run both Replit
   * (primary) and Railway (standby/failover) simultaneously and ops
   * keeps confusing one's screenshots for the other.
   *
   * Mapping (hostname-based, no env vars or API call needed):
   *   *.replit.app   → 'primary'  (current main platform)
   *   *.railway.app  → 'standby'  (kept warm in case Replit breaks)
   *   else           → 'dev'      (localhost, IDE preview, custom domain)
   *
   * Returns 'dev' on any non-recognised host so the badge stays
   * silent during local development.
   */
  getEnvRole() {
    try {
      const h = (window.location.hostname || '').toLowerCase();
      if (h.indexOf('replit.app') !== -1)  return 'primary';
      if (h.indexOf('railway.app') !== -1) return 'standby';
      return 'dev';
    } catch (e) {
      return 'dev';
    }
  },

  /**
   * Inject the env badge into the nav header (next to #lastUpdated) +
   * paint a small standby warning banner above the page when we're on
   * the Railway failover. Banner is dismissable per session but
   * remembers the choice in sessionStorage so it doesn't keep nagging
   * after the operator has acknowledged it.
   *
   * No-ops on 'dev' so the localhost screenshots stay clean.
   */
  applyEnvBadge() {
    const role = this.getEnvRole();
    try { document.body.setAttribute('data-env-role', role); } catch (e) { /* SSR-style guard */ }
    if (role === 'dev') return;

    const PILL = {
      primary: {
        text: 'PRIMARY',
        title: 'Replit deployment — main platform. Writes from this env are the source of truth.',
        cls:   'bg-emerald-100 text-emerald-700 border-emerald-200',
      },
      standby: {
        text: 'STANDBY',
        title: 'Railway deployment — kept warm in case Replit breaks. Avoid writes here unless Replit is down; this DB does not replicate back.',
        cls:   'bg-amber-100 text-amber-800 border-amber-200',
      },
    }[role];
    if (!PILL) return;

    // Pill next to the Last-Updated label in the header. Inserted via
    // querySelector so it doesn't matter which dashboard page we're on
    // — every page renders the same nav header via render().
    try {
      const anchor = document.getElementById('lastUpdated');
      if (anchor && !document.getElementById('wp-env-pill')) {
        const pill = document.createElement('span');
        pill.id = 'wp-env-pill';
        pill.className = 'inline-flex items-center px-2 py-0.5 me-2 rounded-full text-[10px] font-semibold border ' + PILL.cls;
        pill.title = PILL.title;
        pill.textContent = PILL.text;
        anchor.parentNode.insertBefore(pill, anchor);
      }
    } catch (e) { /* DOM not ready; render() will retry on next tick */ }

    // Standby-only: top-of-page warning banner. Yellow strip so a
    // screenshot of Railway looks visibly different from Replit at a
    // glance. Operators can dismiss for the rest of the tab session.
    if (role === 'standby') {
      try {
        if (sessionStorage.getItem('wp-standby-banner-dismissed') === '1') return;
      } catch (e) { /* ignore quota/private-mode errors */ }
      if (document.getElementById('wp-env-banner')) return;
      const bar = document.createElement('div');
      bar.id = 'wp-env-banner';
      bar.setAttribute('role', 'status');
      bar.className = 'w-full bg-amber-50 border-b border-amber-200 text-amber-900 text-xs px-4 py-2 flex items-center justify-between gap-3';
      bar.innerHTML = '<span><strong>Standby environment.</strong> This is the Railway failover — main platform is <a href="https://qms-dashboard.replit.app/" target="_blank" rel="noopener" class="underline font-semibold">qms-dashboard.replit.app</a>. Changes you make here do not replicate back to Replit.</span><button type="button" aria-label="Dismiss" id="wp-env-banner-dismiss" class="text-amber-700 hover:text-amber-900 font-bold text-sm">×</button>';
      document.body.insertBefore(bar, document.body.firstChild);
      try {
        document.getElementById('wp-env-banner-dismiss').addEventListener('click', () => {
          bar.remove();
          try { sessionStorage.setItem('wp-standby-banner-dismissed', '1'); } catch (e) { /* ignore */ }
        });
      } catch (e) { /* event binding failed — banner just stays */ }
    }
  },

  init(currentPageId) {
    this.currentPage = currentPageId;
    // Apply persisted theme BEFORE any DOM rendering so the page never flashes.
    this.applyTheme(this.loadTheme());
    // The recent-pages visit is recorded later, inside loadUserInfo()'s
    // .then() — after the user id resolves — so the visit lands in the
    // correctly-namespaced storage bucket and never bleeds into another
    // account's recent list on a shared browser.
    const doInit = () => {
      this.render();
      this.bindEvents();
      this.loadUserInfo();
      this.pollAlertCount();
      // Re-apply once the nav (and toggle button) are in the DOM so the icon
      // matches the stored preference.
      this.applyTheme(this.loadTheme());
      // Universal click-to-sort on every <table> across the platform.
      // Loaded once from here so individual dashboard pages don't need to
      // include the script tag. The helper is idempotent and self-guards
      // against double-init.
      this._ensureTableSortLoaded();
      // Env badge in the header + standby warning banner. Hostname-
      // detection-based so the dashboard can flag Replit (primary) vs
      // Railway (standby/failover) at a glance without any env-var
      // plumbing. No-op on localhost / IDE preview.
      this.applyEnvBadge();
    };
    if (window.WalaPlusI18n) {
      window.WalaPlusI18n.init().then(doInit);
    } else {
      // i18n script may still be loading — wait for it
      var maxWait = 30;
      var waited = 0;
      var check = setInterval(() => {
        waited++;
        if (window.WalaPlusI18n) {
          clearInterval(check);
          window.WalaPlusI18n.init().then(doInit);
        } else if (waited >= maxWait) {
          clearInterval(check);
          doInit();
        }
      }, 50);
    }
  },

  pollAlertCount() {
    const updateBadge = () => {
      Promise.all([
        fetch('/api/consultant/alerts/count', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { count: 0 }),
        fetch('/api/notifications/count', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { count: 0 })
      ]).then(([alerts, notifs]) => {
        const total = (alerts.count || 0) + (notifs.count || 0);
        const badge = document.getElementById('nav-alert-badge');
        if (!badge) return;
        if (total > 0) {
          badge.textContent = total > 99 ? '99+' : String(total);
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
      }).catch(() => {});
    };
    const loadNotifications = () => {
      fetch('/api/notifications?limit=10&status=unread', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : { notifications: [] })
        .then(data => {
          const list = document.getElementById('nav-notifications-list');
          if (!list) return;
          const items = data.notifications || [];
          if (items.length === 0) {
            list.innerHTML = `<p class="text-center text-sm text-gray-400 py-4">${window.WalaPlusI18n ? window.WalaPlusI18n.t('notifications.no_notifications') : 'No new notifications'}</p>`;
            return;
          }
          list.innerHTML = items.map(n => {
            const time = new Date(n.created_at);
            const ago = this.timeAgo(time);
            const KNOWN_MODULES = {NC:'text-red-500',CAPA:'text-amber-500',RISK:'text-orange-500',COMPLIANCE:'text-blue-500',KPI:'text-green-500'};
            const safeModule = Object.prototype.hasOwnProperty.call(KNOWN_MODULES, n.module) ? n.module : 'System';
            const iconColor = KNOWN_MODULES[safeModule] || 'text-gray-500';
            const safeId = Number.isFinite(Number(n.id)) && Number(n.id) >= 0 ? Number(n.id) : 0;
            return `<button type="button" class="flex items-start space-x-2 p-2 rounded-lg hover:bg-gray-50 w-full text-left" data-on-click="WalaPlusNav.markRead" data-args="[${safeId}]" aria-label="Mark notification as read: ${this.escapeHtml(n.subject||'Notification')}">
              <span class="w-2 h-2 mt-1.5 rounded-full bg-indigo-500 flex-shrink-0" aria-hidden="true"></span>
              <span class="flex-1 min-w-0">
                <span class="block text-sm font-medium text-gray-900 truncate">${this.escapeHtml(n.subject||'Notification')}</span>
                <span class="block text-xs text-gray-500 truncate">${this.escapeHtml(n.message||'')}</span>
                <span class="block text-xs ${iconColor} mt-0.5">${this.escapeHtml(safeModule)} · ${this.escapeHtml(ago)}</span>
              </span>
            </button>`;
          }).join('');
        })
        .catch(() => {});
    };
    updateBadge();
    loadNotifications();
    if (this._notificationPollStarted) return;
    this._notificationPollStarted = true;
    setInterval(updateBadge, 60000);
    setInterval(loadNotifications, 60000);
  },

  timeAgo(date) {
    // Reuse the WalaPlusNav._t method shorthand declared above so the i18n
    // guardrail (Task #411) can statically verify each key lookup instead of
    // having to track a second inline wrapper alias.
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return this._t('nav.time.just_now');
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return mins + this._t('nav.time.minutes_ago');
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + this._t('nav.time.hours_ago');
    const days = Math.floor(hrs / 24);
    return days + this._t('nav.time.days_ago');
  },

  markRead(id) {
    fetch(`/api/notifications/${id}/read`, { method: 'POST', credentials: 'same-origin' })
      .then(() => { this.pollAlertCount(); })
      .catch(() => {});
  },

  async signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    window.location.href = '/api/logout';
  },

  _ensureTableSortLoaded() {
    if (window.__walaplusTableSortInit) return;
    if (document.querySelector('script[data-walaplus-table-sort]')) return;
    var s = document.createElement('script');
    s.src = '/js/table-sort.js?v=1';
    s.async = true;
    s.setAttribute('data-walaplus-table-sort', '1');
    document.head.appendChild(s);
  },

  refreshDashboard() {
    // Visual feedback so the user knows the click registered. Without
    // this the button looked dead on pages whose custom refresh runs
    // silently (e.g. /duplicates CS Lifecycle).
    var btn = document.querySelector('[data-testid="button-refresh"]');
    var originalHtml = null;
    if (btn) {
      originalHtml = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<svg class="w-4 h-4 animate-spin" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg><span>Refreshing…</span>';
    }
    var restore = function () {
      if (btn && originalHtml !== null) {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
      }
    };
    try {
      if (typeof window.refreshDashboard === 'function') {
        // Page-specific refresh hook. Support both sync and async
        // implementations so we can restore the button when work
        // actually finishes rather than immediately.
        var result = window.refreshDashboard();
        if (result && typeof result.then === 'function') {
          result.finally(restore);
        } else {
          setTimeout(restore, 600);
        }
        return;
      }
    } catch (e) {
      // Fall through to reload below so the user still gets fresh data.
      try { console.error('refreshDashboard hook failed:', e); } catch (_) {}
    }
    // Fallback for pages that haven't registered a custom refresh hook:
    // reload the page so the user always gets fresh data from the global
    // header Refresh button, regardless of which dashboard they're on.
    window.location.reload();
  },

  setLang(lang) {
    if (!(window.WalaPlusI18n && typeof window.WalaPlusI18n.setLang === 'function')) return;
    // Disable both language buttons and replace the clicked button's label
    // with a spinner so operators get immediate feedback while the server
    // persists the new preference (and the page reloads).
    var btnEn = document.querySelector('[data-testid="button-lang-en"]');
    var btnAr = document.querySelector('[data-testid="button-lang-ar"]');
    var clicked = lang === 'ar' ? btnAr : btnEn;
    var setBusy = function (busy) {
      [btnEn, btnAr].forEach(function (b) {
        if (!b) return;
        b.disabled = !!busy;
        b.setAttribute('aria-busy', busy ? 'true' : 'false');
        if (busy) b.classList.add('opacity-60', 'cursor-wait');
        else b.classList.remove('opacity-60', 'cursor-wait');
      });
      if (busy && clicked && !clicked.querySelector('[data-lang-spinner]')) {
        var spinner = document.createElement('span');
        spinner.setAttribute('data-lang-spinner', '1');
        spinner.className = 'inline-block w-3 h-3 ms-1 align-middle border-2 border-current border-t-transparent rounded-full animate-spin';
        spinner.setAttribute('aria-hidden', 'true');
        clicked.appendChild(spinner);
      }
    };
    window.WalaPlusI18n.setLang(lang, setBusy);
  },

  setNumerals(useEastern, btnEl) {
    if (window.WalaPlusI18n && typeof window.WalaPlusI18n.setUseEasternNumerals === 'function') {
      window.WalaPlusI18n.setUseEasternNumerals(!!useEastern);
    }
    if (btnEl && btnEl.parentElement) {
      btnEl.parentElement.querySelectorAll('button').forEach(b =>
        b.classList.remove('border-indigo-500', 'bg-indigo-50', 'text-indigo-700', 'font-medium')
      );
      btnEl.classList.add('border-indigo-500', 'bg-indigo-50', 'text-indigo-700', 'font-medium');
    }
  },

  loadUserInfo() {
    // /api/auth/me returns the authenticated user for both OIDC sessions and
    // admin-key callers, so a single round-trip is enough — no separate
    // /api/auth/admin-status fallback is needed.
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(r => (r.ok ? r.json() : { authenticated: false }))
      .then(data => {
        // Capture the authenticated user's id + role. The id namespaces
        // the pin/recent localStorage buckets so a shared browser keeps
        // each account's history separate; the role drives RBAC group
        // visibility. If either changed since the last paint (e.g. the
        // first render happened before /api/auth/me resolved), re-render
        // the rail so newly-visible groups and the user-scoped Pinned/
        // Recent sections appear.
        const newRole = (data && data.authenticated && data.user && data.user.role) || null;
        const newId   = (data && data.authenticated && data.user && data.user.id)   || null;
        const changed = (newRole !== this._userRole) || (newId !== this._userId);
        if (changed) {
          this._userRole = newRole;
          this._userId   = newId;
          this._migrateLegacyState();
          // Now that we know the user scope, record the current page in
          // the correctly-namespaced recent list before re-rendering so
          // it surfaces under "Recent" immediately.
          if (this.currentPage) this.recordVisit(this.currentPage);
          this.render();
          this.bindEvents();
        }
        // Wire the recent-downloads tray to a per-user localStorage
        // namespace so long-running exports survive a tab close, browser
        // restart, or fresh login. Anonymous/unauthenticated visitors keep
        // the legacy per-tab sessionStorage behaviour.
        try {
          const sd = window.streamingDownload;
          if (sd && sd.history && typeof sd.history.setUser === 'function') {
            if (data && data.authenticated && data.user && data.user.id) {
              sd.history.setUser(data.user.id);
            } else {
              sd.history.setUser(null);
            }
          }
        } catch (_) { /* tray wiring is best-effort */ }
        const container = document.getElementById('nav-user-info');
        if (!container) return;
        if (data.authenticated && data.user) {
          const u = data.user;

          // Static skeleton only — no user data interpolated here.
          // The arrow callback inherits `this` from loadUserInfo, so we
          // call WalaPlusNav._t directly at every key site below — no
          // local wrapper alias is needed (Task #411).
          const isAr = window.WalaPlusI18n && window.WalaPlusI18n.currentLang && window.WalaPlusI18n.currentLang() === 'ar';
          // Language toggle is exposed in the user dropdown so operators
          // can switch between English and العربية at runtime. The i18n
          // module persists the choice (localStorage + server preference)
          // and reloads the page so all data-i18n elements pick up the
          // new bundle.
          const SHOW_LANG_TOGGLE = true;
          container.innerHTML = `
            <div class="relative nav-dropdown" data-group="user-menu">
              <button class="flex items-center space-x-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition" aria-label="User menu" aria-haspopup="true" aria-expanded="false" data-testid="button-user-menu">
                <span data-slot="avatar"></span>
                <svg class="w-3 h-3 text-gray-400 dropdown-arrow transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
              </button>
              <div class="dropdown-menu hidden absolute right-0 top-full mt-1 w-56 bg-white rounded-xl shadow-lg border border-gray-200 py-2 z-50">
                <div class="px-4 py-2 border-b border-gray-100">
                  <p class="text-sm font-medium text-gray-900" data-testid="text-user-name"></p>
                  <p class="text-xs text-gray-500" data-testid="text-user-email"></p>
                </div>
                ${SHOW_LANG_TOGGLE ? `<div class="px-4 py-2 border-b border-gray-100">
                  <p class="text-xs font-medium text-gray-500 mb-1" data-i18n="nav.language">${this._t('nav.language')}</p>
                  <div class="flex gap-2">
                    <button data-on-click="WalaPlusNav.setLang" data-args='["en"]'
                      class="flex-1 text-xs px-2 py-1 rounded border transition ${isAr ? 'border-gray-200 text-gray-600 hover:bg-gray-50' : 'border-indigo-500 bg-indigo-50 text-indigo-700 font-medium'}"
                      data-testid="button-lang-en">English</button>
                    <button data-on-click="WalaPlusNav.setLang" data-args='["ar"]'
                      class="flex-1 text-xs px-2 py-1 rounded border transition ${isAr ? 'border-indigo-500 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}"
                      data-testid="button-lang-ar">العربية</button>
                  </div>
                </div>` : ''}
                ${isAr ? `<div class="px-4 py-2 border-b border-gray-100">
                  <p class="text-xs font-medium text-gray-500 mb-1" data-i18n="nav.numerals">الأرقام</p>
                  <div class="flex gap-2">
                    <button data-on-click="WalaPlusNav.setNumerals" data-args='[true]'
                      class="flex-1 text-xs px-2 py-1 rounded border transition border-indigo-500 bg-indigo-50 text-indigo-700 font-medium"
                      data-testid="button-numerals-eastern">١٢٣</button>
                    <button data-on-click="WalaPlusNav.setNumerals" data-args='[false]'
                      class="flex-1 text-xs px-2 py-1 rounded border transition border-gray-200 text-gray-600 hover:bg-gray-50"
                      data-testid="button-numerals-western">123</button>
                  </div>
                </div>` : ''}
                <button data-on-click="WalaPlusNav.signOut" class="flex items-center w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition" data-testid="button-logout">
                  <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
                  <span data-i18n="common.sign_out">${this._t('common.sign_out')}</span>
                </button>
              </div>
            </div>`;

          // Safely inject user-controlled values — never via innerHTML
          container.querySelector('[data-testid="text-user-name"]').textContent = u.name || 'User';
          container.querySelector('[data-testid="text-user-email"]').textContent = u.email;

          const avatarSlot = container.querySelector('[data-slot="avatar"]');
          if (u.picture) {
            const img = document.createElement('img');
            img.src = u.picture;  // property assignment — browser treats value as a plain URL, not HTML
            img.alt = '';
            img.className = 'w-7 h-7 rounded-full border border-gray-200';
            img.referrerPolicy = 'no-referrer';
            avatarSlot.replaceWith(img);
          } else {
            const initials = document.createElement('div');
            initials.className = 'w-7 h-7 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-bold';
            initials.textContent = (u.name || u.email || '?')[0].toUpperCase();
            avatarSlot.replaceWith(initials);
          }

          // The user-menu dropdown was just injected into #nav-user-info,
          // AFTER the initial bindEvents() pass. Re-run only the dropdown
          // binder so the opener button gets a real click-to-toggle handler
          // instead of relying solely on the CSS :hover fallback (which
          // closes the menu the moment the cursor crosses the gap between
          // the avatar trigger and the menu, making the language buttons
          // unreachable). bindDropdownEvents() is idempotent and does NOT
          // re-bind the static handlers (rail toggle, mobile menu, Escape,
          // group accordions, search input) wired by bindEvents().
          this.bindDropdownEvents();
        }
      })
      .catch(() => {});
  },

  isInGroup(groupId) {
    const group = this.navigationGroups.find(g => g.id === groupId);
    if (!group) return false;
    return group.items.some(item => item.id === this.currentPage);
  },

  render() {
    const navContainer = document.getElementById('walaplus-nav');
    if (!navContainer) {
      console.error('WalaPlus Nav: Container #walaplus-nav not found');
      return;
    }

    if (!document.getElementById('walaplus-nav-layout-style')) {
      const style = document.createElement('style');
      style.id = 'walaplus-nav-layout-style';
      if (WALAPLUS_NAV_NONCE) style.setAttribute('nonce', WALAPLUS_NAV_NONCE);
      style.textContent = `
        body { padding-top: 48px; padding-left: 256px; transition: padding-left .2s ease, padding-right .2s ease; }
        body.wp-rail-collapsed { padding-left: 64px; }
        @media (max-width: 767px) {
          body, body.wp-rail-collapsed { padding-left: 0 !important; padding-right: 0 !important; }
        }
        .wp-topstrip { position: fixed; top: 0; left: 0; right: 0; height: 48px; z-index: 30; }
        .wp-rail { position: fixed; top: 48px; bottom: 0; left: 0; width: 256px; z-index: 30;
                   transition: width .2s ease, transform .2s ease; overflow: hidden; }
        body.wp-rail-collapsed .wp-rail { width: 64px; }
        body.wp-rail-collapsed .wp-rail .wp-label { display: none; }
        body.wp-rail-collapsed .wp-rail .wp-search-wrap { display: none; }
        body.wp-rail-collapsed .wp-rail .wp-rail-item { justify-content: center; }
        @media (max-width: 767px) {
          .wp-rail { transform: translateX(-100%); width: 256px !important; box-shadow: 0 8px 24px rgba(0,0,0,.15); }
          body.wp-mobile-open .wp-rail { transform: translateX(0); }
          body.wp-rail-collapsed .wp-rail .wp-label,
          body.wp-rail-collapsed .wp-rail .wp-search-wrap { display: block; }
          body.wp-rail-collapsed .wp-rail .wp-rail-item { justify-content: flex-start; }
        }
        .wp-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 20; display: none; }
        body.wp-mobile-open .wp-backdrop { display: block; }
        @media (min-width: 768px) { .wp-backdrop { display: none !important; } }
        /* Accordion sections */
        .wp-rail-group .wp-group-chevron { transition: transform .15s ease; }
        .wp-rail-group[data-open="true"] .wp-group-chevron { transform: rotate(180deg); }
        .wp-rail-group:not([data-open="true"]) .wp-group-items { display: none; }
        /* When the rail is collapsed to icons, show all items (no accordion) and hide chevrons */
        body.wp-rail-collapsed .wp-rail .wp-rail-group .wp-group-items { display: block !important; }
        body.wp-rail-collapsed .wp-rail .wp-group-chevron { display: none; }
        /* When search is active, force every (still-visible) group open so matches are reachable */
        body.wp-nav-search-active .wp-rail .wp-rail-group .wp-group-items { display: block !important; }
        /* Precompiled tailwind in this project does not ship sm:/md: variants,
           so handle responsive visibility with explicit classes here. */
        .wp-rail-toggle-btn { display: inline-flex; }
        .wp-mobile-menu-btn { display: none; }
        .wp-desktop-only    { display: inline-flex; }
        .wp-tagline         { display: inline; }
        @media (max-width: 767px) {
          .wp-rail-toggle-btn { display: none; }
          .wp-mobile-menu-btn { display: inline-flex; }
          .wp-desktop-only,
          .wp-tagline         { display: none; }
        }

        /* ===== RTL / Arabic Layout Overrides ===== */
        html[dir="rtl"] body {
          padding-left: 0;
          padding-right: 256px;
          font-family: 'Noto Sans Arabic', 'Inter', sans-serif;
        }
        html[dir="rtl"] body.wp-rail-collapsed {
          padding-left: 0;
          padding-right: 64px;
        }
        @media (max-width: 767px) {
          html[dir="rtl"] body,
          html[dir="rtl"] body.wp-rail-collapsed {
            padding-right: 0 !important;
          }
        }
        html[dir="rtl"] .wp-rail {
          left: auto;
          right: 0;
          border-right: none;
          border-left: 1px solid #e5e7eb;
        }
        @media (max-width: 767px) {
          html[dir="rtl"] .wp-rail {
            transform: translateX(100%);
            right: 0;
            left: auto;
          }
          html[dir="rtl"] body.wp-mobile-open .wp-rail {
            transform: translateX(0);
          }
        }
        html[dir="rtl"] .wp-rail-item { flex-direction: row-reverse; text-align: right; }
        html[dir="rtl"] .wp-rail-item .wp-label { text-align: right; }
        html[dir="rtl"] .wp-group-toggle { flex-direction: row-reverse; }
        html[dir="rtl"] .wp-group-toggle .wp-label { text-align: right; }
        html[dir="rtl"] .wp-search-wrap input { direction: rtl; text-align: right; }
        html[dir="rtl"] .dropdown-menu { right: auto; left: 0; }
        html[dir="rtl"] #nav-user-info .dropdown-menu { left: 0; right: auto; }
        html[dir="rtl"] .wp-topstrip { direction: rtl; }
        html[dir="rtl"] .wp-topstrip .flex.items-center.space-x-2 { flex-direction: row-reverse; }
        html[dir="rtl"] #ai-consultant-widget { right: auto; left: 24px; }
        html[dir="rtl"] #ai-widget-panel { right: auto; left: 0; }
        html[dir="rtl"] #ai-widget-input-area { flex-direction: row-reverse; }
        html[dir="rtl"] .widget-msg-user { flex-direction: row-reverse; }
        html[dir="rtl"] .widget-msg-user .bubble { border-radius: 14px 14px 14px 4px; }
        html[dir="rtl"] .widget-msg-ai .bubble { border-radius: 14px 14px 4px 14px; }
      `;
      document.head.appendChild(style);
    }

    if (localStorage.getItem('walaplus-nav-collapsed') === '1') {
      document.body.classList.add('wp-rail-collapsed');
    }

    // Determine which group to auto-open: the one containing the current page.
    // If the current page isn't represented in the menu, fall back to the first group.
    const activeGroup = this.navigationGroups.find(g => this.isInGroup(g.id));
    this._defaultOpenGroupId = activeGroup ? activeGroup.id : (this.navigationGroups[0] && this.navigationGroups[0].id);

    const isRTL = window.WalaPlusI18n && window.WalaPlusI18n.isRTL && window.WalaPlusI18n.isRTL();
    navContainer.innerHTML = `
      <div class="wp-topstrip bg-white border-b border-gray-200 shadow-sm flex items-center justify-between px-3">
        <div class="flex items-center space-x-2">
          <button id="wp-rail-toggle" class="wp-rail-toggle-btn p-2 rounded-lg text-gray-600 hover:bg-gray-100 items-center" aria-label="Toggle navigation menu" aria-controls="walaplus-nav" aria-expanded="true" data-testid="button-rail-toggle">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <button id="mobile-menu-btn" class="wp-mobile-menu-btn p-2 rounded-lg text-gray-600 hover:bg-gray-100 items-center" aria-label="Open navigation menu" aria-controls="walaplus-nav" aria-expanded="false" data-testid="button-mobile-menu">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <a href="/" class="flex items-center" data-testid="link-home">
            <span class="text-lg font-bold text-indigo-600 leading-none" data-i18n="nav.brand">${this._t('nav.brand')}</span>
            <span class="wp-tagline ml-2 rtl:mr-2 rtl:ml-0 text-xs text-gray-500" data-i18n="nav.tagline">${this._t('nav.tagline')}</span>
          </a>
        </div>
        <div class="flex items-center space-x-2">
          <span id="lastUpdated" class="wp-tagline text-xs text-gray-600"></span>
          <button data-on-click="WalaPlusNav.refreshDashboard" class="wp-desktop-only bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition items-center space-x-1 text-sm" aria-label="Refresh dashboard" data-testid="button-refresh">
            <svg class="w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            <span data-i18n="nav.refresh">${this._t('nav.refresh')}</span>
          </button>
          <button id="wp-theme-toggle" data-on-click="WalaPlusNav.toggleTheme" class="wp-theme-toggle relative p-1.5 rounded-lg hover:bg-gray-100 transition" aria-label="Toggle dark mode" title="Toggle dark mode" data-testid="button-theme-toggle">
            <svg class="wp-theme-icon-light w-5 h-5 text-gray-500" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
            <svg class="wp-theme-icon-dark w-5 h-5 text-yellow-300 hidden" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
          </button>
          <div class="relative nav-dropdown" data-group="notifications">
            <button class="relative p-1.5 rounded-lg hover:bg-gray-100 transition" aria-label="${this._t('nav.notifications')}" aria-haspopup="true" aria-expanded="false" aria-controls="nav-notifications-list" data-testid="button-notifications">
              <svg class="w-5 h-5 text-gray-500" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
              <span id="nav-alert-badge" class="hidden absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center font-bold nav-alert-badge-text" aria-live="polite"></span>
            </button>
            <div class="dropdown-menu hidden absolute right-0 top-full mt-1 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50 max-h-96 overflow-hidden">
              <div class="p-3 border-b border-gray-100 flex justify-between items-center">
                <span class="font-semibold text-sm text-gray-900" data-i18n="notifications.title">${this._t('notifications.title')}</span>
                <a href="/consultant" class="text-xs text-indigo-600 hover:text-indigo-800" data-i18n="nav.view_all">${this._t('nav.view_all')}</a>
              </div>
              <div id="nav-notifications-list" class="overflow-y-auto max-h-72 p-2 space-y-1">
                <p class="text-center text-sm text-gray-400 py-4" data-i18n="common.loading">${this._t('common.loading')}</p>
              </div>
            </div>
          </div>
          <div id="nav-user-info" class="flex items-center"></div>
        </div>
      </div>

      <div class="wp-backdrop" id="wp-backdrop"></div>

      <aside id="nav-rail" class="wp-rail bg-white border-r border-gray-200 flex flex-col" aria-label="Primary navigation" data-testid="nav-rail">
        <div class="wp-search-wrap p-3 border-b border-gray-100">
          <div class="relative">
            <svg class="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/></svg>
            <input id="wp-rail-search" type="search" placeholder="${this._t('nav.search_placeholder')}" aria-label="${this._t('nav.search_placeholder')}" data-testid="input-nav-search" class="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
          </div>
        </div>
        <nav class="flex-1 overflow-y-auto overflow-x-hidden py-2" id="wp-rail-nav">
          ${this.renderPinnedGroup()}
          ${this.renderRecentGroup()}
          ${this.navigationGroups.filter(g => this._canSeeGroup(g)).map(group => this.renderRailGroup(group)).join('')}
          <div id="wp-nav-empty" class="wp-nav-empty hidden px-4 py-6 text-center text-xs text-gray-500" data-testid="text-nav-no-results">
            ${this.escapeHtml(this._t('nav.no_results'))}
          </div>
        </nav>
        <div class="wp-label border-t border-gray-100 px-3 py-2 text-center flex-shrink-0">
          <a href="/a11y" class="text-xs text-gray-600 hover:text-indigo-700 underline" aria-label="Accessibility statement">Accessibility</a>
        </div>
      </aside>
    `;
  },

  renderRailGroup(group) {
    const colors = this.getColorClasses(group.color);
    const groupActive = this.isInGroup(group.id);
    const open = group.id === this._defaultOpenGroupId;
    const label = this._navGroupLabel(group.id) || group.label;
    return `
      <div class="wp-rail-group px-2 mb-1" data-group="${this.escapeHtml(group.id)}" data-open="${open ? 'true' : 'false'}">
        <button type="button" class="wp-group-toggle w-full flex items-center px-2 py-2 rounded-lg hover:bg-gray-50 transition relative" aria-expanded="${open ? 'true' : 'false'}" aria-describedby="tooltip-group-${this.escapeHtml(group.id)}" data-testid="button-group-${this.escapeHtml(group.id)}">
          <span class="${colors.text} me-2 flex-shrink-0" aria-hidden="true">${group.icon}</span>
          <span class="wp-label flex-1 text-start text-xs font-semibold uppercase tracking-wide ${groupActive ? colors.text : 'text-gray-500'}">${this.escapeHtml(label)}</span>
          <svg class="wp-label wp-group-chevron w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          <span id="tooltip-group-${this.escapeHtml(group.id)}" role="tooltip" class="wp-nav-tooltip">${this.escapeHtml(label)}</span>
        </button>
        <div class="wp-group-items mt-0.5 gap-y-0.5 ps-1" role="group" aria-label="${this.escapeHtml(label)}">
          ${group.items.filter(item => this._canSeeItem(item)).map(item => this.renderRailItem(item, colors, { showPin: true })).join('')}
        </div>
      </div>
    `;
  },

  renderPinnedGroup() {
    var pinned = this.loadPinned();
    if (!pinned.length) return '';
    var idx = this._buildItemIndex();
    var pinnedItems = pinned
      .map(function (id) { return idx[id]; })
      .filter(function (e) { return e; });
    if (!pinnedItems.length) return '';
    var label = this._t('nav.pinned');
    var open = true;
    return `
      <div class="wp-rail-group wp-rail-group-meta px-2 mb-1" data-group="pinned" data-open="${open ? 'true' : 'false'}">
        <button type="button" class="wp-group-toggle w-full flex items-center px-2 py-2 rounded-lg hover:bg-gray-50 transition relative" aria-expanded="${open ? 'true' : 'false'}" aria-describedby="tooltip-group-pinned" data-testid="button-group-pinned">
          <span class="text-amber-600 me-2 flex-shrink-0" aria-hidden="true">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M5.5 2a.5.5 0 010-1h9a.5.5 0 010 1h-1l-1 5 3 4v1H10v6l-1 1-1-1v-6H3.5v-1l3-4-1-5h-1z"/></svg>
          </span>
          <span class="wp-label flex-1 text-start text-xs font-semibold uppercase tracking-wide text-gray-500">${this.escapeHtml(label)}</span>
          <svg class="wp-label wp-group-chevron w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          <span id="tooltip-group-pinned" role="tooltip" class="wp-nav-tooltip">${this.escapeHtml(label)}</span>
        </button>
        <div class="wp-group-items mt-0.5 gap-y-0.5 ps-1" role="group" aria-label="${this.escapeHtml(label)}">
          ${pinnedItems.map(e => this.renderRailItem(e.item, this.getColorClasses(e.group.color), { showPin: true, idSuffix: 'pinned' })).join('')}
        </div>
      </div>
    `;
  },

  renderRecentGroup() {
    var recent = this.loadRecent();
    var pinned = this.loadPinned();
    var idx = this._buildItemIndex();
    var recentItems = recent
      .filter(function (id) { return pinned.indexOf(id) === -1; })
      .map(function (id) { return idx[id]; })
      .filter(function (e) { return e; });
    if (!recentItems.length) return '';
    var label = this._t('nav.recent');
    var open = true;
    return `
      <div class="wp-rail-group wp-rail-group-meta px-2 mb-1" data-group="recent" data-open="${open ? 'true' : 'false'}">
        <button type="button" class="wp-group-toggle w-full flex items-center px-2 py-2 rounded-lg hover:bg-gray-50 transition relative" aria-expanded="${open ? 'true' : 'false'}" aria-describedby="tooltip-group-recent" data-testid="button-group-recent">
          <span class="text-gray-500 me-2 flex-shrink-0" aria-hidden="true">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </span>
          <span class="wp-label flex-1 text-start text-xs font-semibold uppercase tracking-wide text-gray-500">${this.escapeHtml(label)}</span>
          <svg class="wp-label wp-group-chevron w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
          <span id="tooltip-group-recent" role="tooltip" class="wp-nav-tooltip">${this.escapeHtml(label)}</span>
        </button>
        <div class="wp-group-items mt-0.5 gap-y-0.5 ps-1" role="group" aria-label="${this.escapeHtml(label)}">
          ${recentItems.map(e => this.renderRailItem(e.item, this.getColorClasses(e.group.color), { showPin: false, idSuffix: 'recent' })).join('')}
        </div>
      </div>
    `;
  },

  renderRailItem(item, colors, opts) {
    opts = opts || {};
    const isActive = item.id === this.currentPage;
    const target = item.external ? 'target="_blank"' : '';
    const label = this._navItemLabel(item.id) || item.label;
    const suffix = opts.idSuffix ? `-${opts.idSuffix}` : '';
    const tooltipId = `tooltip-nav-${this.escapeHtml(item.id)}${suffix}`;
    const pinned = this.loadPinned().indexOf(item.id) !== -1;
    const pinAria = pinned ? this._t('nav.unpin_action') : this._t('nav.pin_action');
    // Pin button is rendered as a SIBLING of the link (not nested inside
    // <a>): nested interactive elements are invalid HTML and would let a
    // pin click bubble into a navigation. The row container owns the
    // hover/focus styling so the link and button still feel like one row.
    const pinBtn = opts.showPin ? `
      <button type="button" class="wp-pin-btn flex-shrink-0 p-1 rounded text-gray-400 hover:text-amber-600 hover:bg-amber-50 ${pinned ? 'wp-pinned' : ''}"
        data-on-click="WalaPlusNav.togglePin" data-args='["${this.escapeHtml(item.id)}"]'
        aria-label="${this.escapeHtml(pinAria)} ${this.escapeHtml(label)}"
        aria-pressed="${pinned ? 'true' : 'false'}"
        data-testid="button-pin-${this.escapeHtml(item.id)}${suffix}">
        <svg class="w-3.5 h-3.5" fill="${pinned ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 20 20"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5.5 2h9a.5.5 0 010 1h-1l-1 5 3 4v1H10v6l-1 1-1-1v-6H3.5v-1l3-4-1-5h-1a.5.5 0 010-1z"/></svg>
      </button>
    ` : '';
    return `
      <div class="wp-rail-row relative group flex items-center gap-1 rounded-lg ${isActive ? `wp-rail-row-active ${colors.lightBg}` : 'hover:bg-gray-50'}">
        <a href="${this.escapeHtml(item.href)}" ${target}
           class="wp-rail-item flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500
             ${isActive ? `wp-rail-item-active ${colors.text} font-semibold` : 'text-gray-700'}"
           ${isActive ? 'aria-current="page"' : ''}
           aria-describedby="${tooltipId}"
           data-nav-item
           data-item-id="${this.escapeHtml(item.id)}"
           data-label="${this.escapeHtml(label.toLowerCase())}"
           data-i18n-nav-item="${this.escapeHtml(item.id)}"
           data-testid="link-nav-${this.escapeHtml(item.id)}${suffix}">
          <span class="flex-shrink-0 ${colors.text}" aria-hidden="true">${this.getItemIcon(item.icon)}</span>
          <span class="wp-label wp-rail-item-label truncate flex-1" data-original="${this.escapeHtml(label)}">${this.escapeHtml(label)}</span>
          ${item.external ? '<svg class="wp-label w-3 h-3 text-gray-400 ms-auto flex-shrink-0" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>' : ''}
          <span id="${tooltipId}" role="tooltip" class="wp-nav-tooltip">${this.escapeHtml(label)}</span>
        </a>
        ${pinBtn ? `<div class="wp-pin-slot flex-shrink-0 pe-1">${pinBtn}</div>` : ''}
      </div>
    `;
  },

  // Idempotent: safe to call any time new .nav-dropdown elements are
  // added to the DOM (e.g. after loadUserInfo() injects the user-menu).
  // The per-button data-nav-bound flag and the single-shot doc closer
  // guard prevent duplicate handlers on re-runs.
  bindDropdownEvents() {
    document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
      const btn = dropdown.querySelector('button');
      const menu = dropdown.querySelector('.dropdown-menu');
      const arrow = dropdown.querySelector('.dropdown-arrow');
      if (!btn || !menu) return;
      if (btn.dataset.navBound === '1') return;
      btn.dataset.navBound = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !menu.classList.contains('hidden');
        this.closeAllDropdowns();
        if (!isOpen) {
          menu.classList.remove('hidden');
          btn.setAttribute('aria-expanded', 'true');
          if (arrow) arrow.classList.add('rotate-180');
        }
      });
    });
    if (!this._docClosersBound) {
      this._docClosersBound = true;
      document.addEventListener('click', () => this.closeAllDropdowns());
    }
  },

  bindEvents() {
    // Dropdown wiring is split out so loadUserInfo() can re-run only the
    // dropdown binder after injecting the user-menu, without duplicating
    // the static handlers below (rail toggle, mobile menu, Escape, group
    // accordions, search input).
    this.bindDropdownEvents();

    const railToggle = document.getElementById('wp-rail-toggle');
    if (railToggle) {
      // Reflect current state on first paint
      railToggle.setAttribute('aria-expanded', document.body.classList.contains('wp-rail-collapsed') ? 'false' : 'true');
      railToggle.addEventListener('click', () => {
        document.body.classList.toggle('wp-rail-collapsed');
        const collapsed = document.body.classList.contains('wp-rail-collapsed');
        railToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        try { localStorage.setItem('walaplus-nav-collapsed', collapsed ? '1' : '0'); } catch(_) {}
      });
    }

    // Mobile drawer open/close. The hamburger and search input are
    // re-created by render() on every re-paint (role-aware re-render
    // after /api/auth/me, togglePin, recordVisit), so close/open helpers
    // resolve `#mobile-menu-btn` lazily at call time. The "what to focus
    // on close" handle is kept on the instance (not in a closure) so the
    // document-level Escape handler — which is bound exactly once — sees
    // the most recent value across all subsequent renders.
    const closeMobileRail = () => {
      if (!document.body.classList.contains('wp-mobile-open')) return;
      document.body.classList.remove('wp-mobile-open');
      const liveBtn = document.getElementById('mobile-menu-btn');
      if (liveBtn) liveBtn.setAttribute('aria-expanded', 'false');
      const focusTarget = (this._lastFocusBeforeMobile && document.body.contains(this._lastFocusBeforeMobile))
        ? this._lastFocusBeforeMobile
        : liveBtn;
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
      this._lastFocusBeforeMobile = null;
    };
    const openMobileRail = () => {
      this._lastFocusBeforeMobile = document.activeElement;
      document.body.classList.add('wp-mobile-open');
      const liveBtn = document.getElementById('mobile-menu-btn');
      if (liveBtn) liveBtn.setAttribute('aria-expanded', 'true');
      const searchInput = document.getElementById('wp-rail-search');
      if (searchInput) setTimeout(() => searchInput.focus(), 50);
    };
    // Stash on the instance so other call sites (e.g. the once-bound
    // Escape handler) can reach the current closure across re-renders.
    this._closeMobileRail = closeMobileRail;
    this._openMobileRail = openMobileRail;

    const mobileBtn = document.getElementById('mobile-menu-btn');
    const backdrop = document.getElementById('wp-backdrop');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.body.classList.contains('wp-mobile-open')) closeMobileRail();
        else openMobileRail();
      });
    }
    if (backdrop) {
      backdrop.addEventListener('click', () => closeMobileRail());
    }

    // Document-level keyboard handlers — bound exactly once. The Escape
    // path resolves `this._closeMobileRail` at event time so it always
    // calls the latest closure (which in turn resolves the live button),
    // even after render() rebuilds the rail and the hamburger.
    if (!this._docKeysBound) {
      this._docKeysBound = true;
      document.addEventListener('keydown', (e) => {
        // Escape closes the mobile drawer
        if (e.key === 'Escape' && document.body.classList.contains('wp-mobile-open')) {
          if (typeof this._closeMobileRail === 'function') this._closeMobileRail();
          return;
        }
        // `/` focuses the rail search input (unless the user is already
        // typing into a form field, where it should pass through).
        if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const tag = (e.target && e.target.tagName) || '';
          const editable = e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tag));
          if (!editable) {
            const si = document.getElementById('wp-rail-search');
            if (si) { e.preventDefault(); si.focus(); si.select && si.select(); }
          }
        }
      });
    }

    // Mobile drawer focus trap: when the drawer is open, cycle Tab focus
    // inside the rail and never escape into the (visually hidden, but
    // still tab-reachable) page content behind the backdrop. The handler
    // resolves `#nav-rail` lazily on every keydown so it always targets
    // the live element, even after render() rebuilds the rail (e.g. when
    // /api/auth/me resolves and triggers a role-aware re-render).
    if (!this._focusTrapBound) {
      this._focusTrapBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        if (!document.body.classList.contains('wp-mobile-open')) return;
        const liveRail = document.getElementById('nav-rail');
        if (!liveRail) return;
        const focusables = liveRail.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    }

    // Group toggles: click + keyboard (Enter/Space). Buttons natively
    // handle Enter/Space → click, so a single click handler is sufficient.
    document.querySelectorAll('.wp-group-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const group = btn.closest('.wp-rail-group');
        if (!group) return;
        const isOpen = group.getAttribute('data-open') === 'true';
        group.setAttribute('data-open', isOpen ? 'false' : 'true');
        btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      });
    });

    // Roving tabindex + arrow-key navigation across all rail items
    // (group headers + leaf links). The currently-active leaf gets
    // tabindex=0; everything else gets tabindex=-1 so Tab moves through
    // the rail in a single jump and ArrowUp/Down moves WITHIN it.
    const railNav = document.getElementById('wp-rail-nav');
    if (railNav) {
      const collectFocusables = () => Array.from(railNav.querySelectorAll(
        '.wp-group-toggle, .wp-rail-item'
      )).filter(el => el.offsetParent !== null);
      const setRoving = (focused) => {
        const list = collectFocusables();
        list.forEach(el => el.setAttribute('tabindex', el === focused ? '0' : '-1'));
      };
      // Initial roving state — prefer the active item, else the first.
      const active = railNav.querySelector('.wp-rail-item-active') || railNav.querySelector('.wp-rail-item, .wp-group-toggle');
      setRoving(active);

      railNav.addEventListener('keydown', (e) => {
        // Enter/Space activate the focused leaf link. Buttons (group
        // toggles) handle these natively, but anchors only respond to
        // Enter — Space scrolls the page by default. Intercept Space on
        // a focused rail item and trigger its click so the activation
        // contract matches the rest of the rail.
        if ((e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter')) {
          const link = e.target.closest && e.target.closest('a.wp-rail-item');
          if (link && document.activeElement === link) {
            if (e.key === 'Enter') return; // browser already navigates
            e.preventDefault();
            link.click();
            return;
          }
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const list = collectFocusables();
        if (!list.length) return;
        const i = list.indexOf(document.activeElement);
        let next = null;
        if (e.key === 'ArrowDown') next = list[Math.min(list.length - 1, i + 1)] || list[0];
        else if (e.key === 'ArrowUp') next = list[Math.max(0, i - 1)] || list[list.length - 1];
        else if (e.key === 'Home') next = list[0];
        else if (e.key === 'End') next = list[list.length - 1];
        if (next) {
          e.preventDefault();
          setRoving(next);
          next.focus();
        }
      });
      // Keep roving in sync after the user clicks/focuses an item via mouse.
      railNav.addEventListener('focusin', (e) => {
        const target = e.target.closest('.wp-group-toggle, .wp-rail-item');
        if (target) setRoving(target);
      });
    }

    // Track navigations: when the user clicks a leaf link, record it in
    // recents so the next page-load surfaces it under the Recent group.
    document.querySelectorAll('[data-nav-item]').forEach(a => {
      a.addEventListener('click', () => {
        const id = a.getAttribute('data-item-id');
        if (id) this.recordVisit(id);
      });
    });

    // Search: filter, highlight matched substring, show "No results" empty
    // state when nothing matches. Uses textContent + DOM nodes (no
    // innerHTML interpolation of user input) and CSSOM property assignment
    // for show/hide so the strict CSP holds.
    const searchInput = document.getElementById('wp-rail-search');
    const emptyState = document.getElementById('wp-nav-empty');
    if (searchInput) {
      const renderHighlight = (labelEl, q) => {
        const original = labelEl.getAttribute('data-original') || labelEl.textContent;
        labelEl.textContent = '';
        if (!q) { labelEl.textContent = original; return; }
        const lower = original.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) { labelEl.textContent = original; return; }
        const before = document.createTextNode(original.slice(0, idx));
        const mark = document.createElement('mark');
        mark.className = 'wp-nav-mark';
        mark.textContent = original.slice(idx, idx + q.length);
        const after = document.createTextNode(original.slice(idx + q.length));
        labelEl.appendChild(before);
        labelEl.appendChild(mark);
        labelEl.appendChild(after);
      };
      searchInput.addEventListener('input', (e) => {
        const q = (e.target.value || '').trim().toLowerCase();
        document.body.classList.toggle('wp-nav-search-active', q.length > 0);
        let totalVisible = 0;
        document.querySelectorAll('.wp-rail-group').forEach(group => {
          let visibleCount = 0;
          group.querySelectorAll('[data-nav-item]').forEach(item => {
            const label = item.getAttribute('data-label') || '';
            const match = !q || label.includes(q);
            // Hide the entire row (link + sibling pin slot), not just the
            // anchor — otherwise non-matching rows render as blank/pin-
            // only artifacts when the group has at least one match.
            const row = item.closest('.wp-rail-row') || item;
            row.style.display = match ? '' : 'none';
            const labelEl = item.querySelector('.wp-rail-item-label');
            if (labelEl) renderHighlight(labelEl, match ? q : '');
            if (match) visibleCount++;
          });
          group.style.display = visibleCount === 0 && q ? 'none' : '';
          if (visibleCount > 0) totalVisible += visibleCount;
        });
        if (emptyState) {
          emptyState.classList.toggle('hidden', !(q && totalVisible === 0));
        }
      });
    }
  },

  closeAllDropdowns() {
    document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
      const menu = dropdown.querySelector('.dropdown-menu');
      const btn = dropdown.querySelector('button');
      const arrow = dropdown.querySelector('.dropdown-arrow');
      if (menu) menu.classList.add('hidden');
      if (btn && btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
      if (arrow) arrow.classList.remove('rotate-180');
    });
  }
};

window.WalaPlusNav = WalaPlusNav;
// Register the WalaPlusNav namespace with SafeActions so that
// data-on-click="WalaPlusNav.signOut" (and every other dotted handler the nav
// renders — setLang, setNumerals, refreshDashboard, markRead, togglePin, …)
// can be resolved by the strict allowlist resolver. Without this, the registry
// only contains functions auto-scanned from window, and namespace objects are
// silently dropped, leaving the buttons inert.
if (window.SafeActions && typeof window.SafeActions.register === 'function') {
  window.SafeActions.register('WalaPlusNav', WalaPlusNav);
}
