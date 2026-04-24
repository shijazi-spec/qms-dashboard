/**
 * WalaPlus Unified Navigation Component
 * Enterprise-grade grouped dropdown navigation for scalability
 */

const WalaPlusNav = {
  currentPage: '',

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
        { label: 'CRM Data', href: '/crm', icon: 'database', id: 'crm' },
        { label: 'Internal Audits', href: '/audits', icon: 'clipboard-check', id: 'audits' },
        { label: 'Calls', href: '/calls', icon: 'phone', id: 'calls' },
        { label: 'Duplicates Radar', href: '/duplicates', icon: 'duplicate', id: 'duplicates' }
      ]
    },
    {
      id: 'grc',
      label: 'GRC',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>`,
      color: 'slate',
      items: [
        { label: 'Control Tower', href: '/grc', icon: 'shield-check', id: 'grc' },
        { label: 'Table F', href: '/tablef', icon: 'table', id: 'tablef' },
        { label: 'Risk Mgmt', href: '/risks', icon: 'exclamation-triangle', id: 'risks' },
        { label: 'Integrated QMS', href: '/qms', icon: 'shield-check', id: 'qms' },
        { label: 'Compliance', href: '/compliance', icon: 'check-circle', id: 'compliance' },
        { label: 'External Audits', href: '/external-audits', icon: 'clipboard-check', id: 'external-audits' },
        { label: 'Vendors', href: '/vendors', icon: 'users', id: 'vendors' },
        { label: 'Mgmt Review', href: '/reviews', icon: 'clipboard-list', id: 'reviews' }
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
        { label: "Mohammed's SOW", href: '/mohammed-sow', icon: 'document', id: 'mohammed-sow' }
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
      id: 'support',
      label: 'Support',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      color: 'purple',
      items: [
        { label: 'AI Consultant', href: '/consultant', icon: 'brain', id: 'consultant' },
        { label: 'User Guide', href: '/guide', icon: 'book-open', id: 'guide' },
        { label: 'Help', href: '/onboarding', icon: 'question-mark-circle', id: 'onboarding' },
        { label: 'Give Feedback', href: '/feedback', icon: 'chat-alt', id: 'feedback' },
        { label: 'Scope of Work', href: '/docs/SCOPE_OF_WORK.html', icon: 'document', id: 'scope', external: true }
      ]
    },
    {
      // Admin & Tools: houses platform-wide operator tooling that is not
      // day-to-day for Quality/GRC users (data loading, RBAC, HITL queue,
      // system health, logs). Gated by role at render time.
      id: 'admin',
      label: 'Admin & Tools',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
      color: 'slate',
      requiresRole: ['admin', 'head_of_operations_quality', 'grc_manager', 'quality_manager', 'ai_specialist'],
      items: [
        { label: 'Data Migration Engine', href: '/migration', icon: 'database', id: 'migration' },
        { label: 'User & Role Management', href: '/admin', icon: 'cog', id: 'admin' },
        { label: 'Users & Access', href: '/users', icon: 'users', id: 'users' },
        { label: 'AI Approvals Queue', href: '/ai-approvals', icon: 'check-circle', id: 'ai-approvals' },
        { label: 'AI Operations', href: '/ai-ops', icon: 'chip', id: 'ai-ops' },
        { label: 'Infographic Generator', href: '/infographic', icon: 'photograph', id: 'infographic' },
        { label: 'System Logs', href: '/logs', icon: 'document-report', id: 'logs' },
        { label: 'Health Pulse', href: '/dashboard/health', icon: 'shield-check', id: 'health' }
      ]
    }
  ],

  getColorClasses(color) {
    const colors = {
      blue: { bg: 'bg-blue-600', hover: 'hover:bg-blue-700', text: 'text-blue-600', lightBg: 'bg-blue-50' },
      slate: { bg: 'bg-slate-700', hover: 'hover:bg-slate-800', text: 'text-slate-700', lightBg: 'bg-slate-50' },
      amber: { bg: 'bg-amber-700', hover: 'hover:bg-amber-800', text: 'text-amber-800', lightBg: 'bg-amber-50' },
      green: { bg: 'bg-green-600', hover: 'hover:bg-green-700', text: 'text-green-600', lightBg: 'bg-green-50' },
      purple: { bg: 'bg-purple-600', hover: 'hover:bg-purple-700', text: 'text-purple-600', lightBg: 'bg-purple-50' }
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

  init(currentPageId) {
    this.currentPage = currentPageId;
    this.render();
    this.bindEvents();
    this.loadUserInfo();
    this.pollAlertCount();
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
            list.innerHTML = '<p class="text-center text-sm text-gray-600 py-4">No new notifications</p>';
            return;
          }
          list.innerHTML = items.map(n => {
            const time = new Date(n.created_at);
            const ago = this.timeAgo(time);
            const KNOWN_MODULES = {NC:'text-red-500',CAPA:'text-amber-500',RISK:'text-orange-500',COMPLIANCE:'text-blue-500',KPI:'text-green-500'};
            const safeModule = Object.prototype.hasOwnProperty.call(KNOWN_MODULES, n.module) ? n.module : 'System';
            const iconColor = KNOWN_MODULES[safeModule] || 'text-gray-500';
            const safeId = Number.isFinite(Number(n.id)) && Number(n.id) >= 0 ? Number(n.id) : 0;
            return `<button type="button" class="flex items-start space-x-2 p-2 rounded-lg hover:bg-gray-50 w-full text-left" onclick="WalaPlusNav.markRead(${safeId})" aria-label="Mark notification as read: ${this.escapeHtml(n.subject||'Notification')}">
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
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
  },

  markRead(id) {
    fetch(`/api/notifications/${id}/read`, { method: 'POST', credentials: 'same-origin' })
      .then(() => { this.pollAlertCount(); })
      .catch(() => {});
  },

  loadUserInfo() {
    fetch('/api/auth/me')
      .then(r => { if (!r.ok) return { authenticated: false }; return r.json(); })
      .then(data => {
        const container = document.getElementById('nav-user-info');
        if (!container) return;
        if (data.authenticated && data.user) {
          const u = data.user;

          // Static skeleton only — no user data interpolated here
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
                <button onclick="(async()=>{await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'});window.location.href='/api/logout';})()" class="flex items-center w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition" data-testid="button-logout">
                  <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
                  Sign out
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
      style.textContent = `
        body { padding-top: 48px; padding-left: 256px; transition: padding-left .2s ease; }
        body.wp-rail-collapsed { padding-left: 64px; }
        @media (max-width: 767px) {
          body, body.wp-rail-collapsed { padding-left: 0 !important; }
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

    navContainer.innerHTML = `
      <div class="wp-topstrip bg-white border-b border-gray-200 shadow-sm flex items-center justify-between px-3">
        <div class="flex items-center space-x-2">
          <button id="wp-rail-toggle" class="wp-rail-toggle-btn p-2 rounded-lg text-gray-600 hover:bg-gray-100 items-center" title="Toggle menu" aria-label="Toggle navigation menu" aria-controls="walaplus-nav" aria-expanded="true" data-testid="button-rail-toggle">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <button id="mobile-menu-btn" class="wp-mobile-menu-btn p-2 rounded-lg text-gray-600 hover:bg-gray-100 items-center" title="Open menu" aria-label="Open navigation menu" aria-controls="walaplus-nav" aria-expanded="false" data-testid="button-mobile-menu">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <a href="/" class="flex items-center" data-testid="link-home">
            <span class="text-lg font-bold text-indigo-600 leading-none">WalaPlus</span>
            <span class="wp-tagline ml-2 text-xs text-gray-500">Enterprise GRC &amp; Quality</span>
          </a>
        </div>
        <div class="flex items-center space-x-2">
          <span id="lastUpdated" class="wp-tagline text-xs text-gray-600"></span>
          <button onclick="typeof refreshDashboard === 'function' && refreshDashboard()" class="wp-desktop-only bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition items-center space-x-1 text-sm" aria-label="Refresh dashboard" data-testid="button-refresh">
            <svg class="w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            <span>Refresh</span>
          </button>
          <div class="relative nav-dropdown" data-group="notifications">
            <button class="relative p-1.5 rounded-lg hover:bg-gray-100 transition" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" aria-controls="nav-notifications-list" data-testid="button-notifications">
              <svg class="w-5 h-5 text-gray-500" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
              <span id="nav-alert-badge" class="hidden absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs rounded-full min-w-[18px] h-[18px] flex items-center justify-center font-bold" aria-live="polite" style="font-size:10px"></span>
            </button>
            <div class="dropdown-menu hidden absolute right-0 top-full mt-1 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50 max-h-96 overflow-hidden">
              <div class="p-3 border-b border-gray-100 flex justify-between items-center">
                <span class="font-semibold text-sm text-gray-900">Notifications</span>
                <a href="/consultant" class="text-xs text-indigo-600 hover:text-indigo-800">View All</a>
              </div>
              <div id="nav-notifications-list" class="overflow-y-auto max-h-72 p-2 space-y-1">
                <p class="text-center text-sm text-gray-600 py-4">Loading...</p>
              </div>
            </div>
          </div>
          <div id="nav-user-info" class="flex items-center"></div>
        </div>
      </div>

      <div class="wp-backdrop" id="wp-backdrop"></div>

      <aside class="wp-rail bg-white border-r border-gray-200 flex flex-col" aria-label="Primary navigation">
        <div class="wp-search-wrap p-3 border-b border-gray-100">
          <div class="relative">
            <svg class="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z"/></svg>
            <input id="wp-rail-search" type="search" placeholder="Search menu..." aria-label="Search menu" data-testid="input-nav-search" class="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
          </div>
        </div>
        <nav class="flex-1 overflow-y-auto py-2" id="wp-rail-nav">
          ${this.navigationGroups.map(group => this.renderRailGroup(group)).join('')}
        </nav>
        <div class="wp-label border-t border-gray-100 px-3 py-2 text-center" style="flex-shrink:0;">
          <a href="/a11y" class="text-xs text-gray-600 hover:text-indigo-700 underline" aria-label="Accessibility statement">Accessibility</a>
        </div>
      </aside>
    `;
  },

  renderRailGroup(group) {
    const colors = this.getColorClasses(group.color);
    const groupActive = this.isInGroup(group.id);
    const open = group.id === this._defaultOpenGroupId; // current page's group, else first group
    return `
      <div class="wp-rail-group px-2 mb-1" data-group="${this.escapeHtml(group.id)}" data-open="${open ? 'true' : 'false'}">
        <button type="button" class="wp-group-toggle w-full flex items-center px-2 py-2 rounded-lg hover:bg-gray-50 transition" aria-expanded="${open ? 'true' : 'false'}" title="${this.escapeHtml(group.label)}" data-testid="button-group-${this.escapeHtml(group.id)}">
          <span class="${colors.text} mr-2 flex-shrink-0">${group.icon}</span>
          <span class="wp-label flex-1 text-left text-xs font-semibold uppercase tracking-wide ${groupActive ? colors.text : 'text-gray-500'}">${this.escapeHtml(group.label)}</span>
          <svg class="wp-label wp-group-chevron w-3 h-3 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
        </button>
        <div class="wp-group-items mt-0.5 space-y-0.5 pl-1">
          ${group.items.map(item => this.renderRailItem(item, colors)).join('')}
        </div>
      </div>
    `;
  },

  renderRailItem(item, colors) {
    const isActive = item.id === this.currentPage;
    const target = item.external ? 'target="_blank"' : '';
    return `
      <a href="${this.escapeHtml(item.href)}" ${target}
         class="wp-rail-item flex items-center space-x-2 px-2 py-2 rounded-lg text-sm transition
           ${isActive ? `${colors.lightBg} ${colors.text} font-medium` : 'text-gray-700 hover:bg-gray-50'}"
         title="${this.escapeHtml(item.label)}"
         data-nav-item
         data-label="${this.escapeHtml(item.label.toLowerCase())}"
         data-testid="link-nav-${this.escapeHtml(item.id)}">
        <span class="flex-shrink-0">${this.getItemIcon(item.icon)}</span>
        <span class="wp-label truncate">${this.escapeHtml(item.label)}</span>
        ${item.external ? '<svg class="wp-label w-3 h-3 text-gray-400 ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>' : ''}
      </a>
    `;
  },

  bindEvents() {
    document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
      const btn = dropdown.querySelector('button');
      const menu = dropdown.querySelector('.dropdown-menu');
      const arrow = dropdown.querySelector('.dropdown-arrow');
      if (!btn || !menu) return;
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
    document.addEventListener('click', () => this.closeAllDropdowns());

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

    const mobileBtn = document.getElementById('mobile-menu-btn');
    const backdrop = document.getElementById('wp-backdrop');
    const closeMobileRail = () => {
      if (!document.body.classList.contains('wp-mobile-open')) return;
      document.body.classList.remove('wp-mobile-open');
      if (mobileBtn) {
        mobileBtn.setAttribute('aria-expanded', 'false');
        mobileBtn.focus();
      }
    };
    const openMobileRail = () => {
      document.body.classList.add('wp-mobile-open');
      if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'true');
      const searchInput = document.getElementById('wp-rail-search');
      if (searchInput) setTimeout(() => searchInput.focus(), 50);
    };
    if (mobileBtn) {
      mobileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.body.classList.contains('wp-mobile-open')) closeMobileRail();
        else openMobileRail();
      });
    }
    if (backdrop) {
      backdrop.addEventListener('click', closeMobileRail);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('wp-mobile-open')) {
        closeMobileRail();
      }
    });

    // Accordion: click a group header to expand/collapse
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

    const searchInput = document.getElementById('wp-rail-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = (e.target.value || '').trim().toLowerCase();
        document.body.classList.toggle('wp-nav-search-active', q.length > 0);
        document.querySelectorAll('.wp-rail-group').forEach(group => {
          let visibleCount = 0;
          group.querySelectorAll('[data-nav-item]').forEach(item => {
            const label = item.getAttribute('data-label') || '';
            const match = !q || label.includes(q);
            item.style.display = match ? '' : 'none';
            if (match) visibleCount++;
          });
          group.style.display = visibleCount === 0 ? 'none' : '';
        });
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
