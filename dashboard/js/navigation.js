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
        { label: 'Audit Reports', href: '/qms', icon: 'shield-check', id: 'qms' },
        { label: 'Audits', href: '/audits', icon: 'clipboard-check', id: 'audits' },
        { label: 'Calls', href: '/calls', icon: 'phone', id: 'calls' },
        { label: 'Duplicate Radar', href: '/duplicates', icon: 'duplicate', id: 'duplicates' }
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
        { label: 'Risks', href: '/risks', icon: 'exclamation-triangle', id: 'risks' },
        { label: 'Policies', href: '/policies', icon: 'document-text', id: 'policies' },
        { label: 'Compliance', href: '/compliance', icon: 'check-circle', id: 'compliance' },
        { label: 'Vendors', href: '/vendors', icon: 'users', id: 'vendors' },
        { label: 'Migration', href: '/migration', icon: 'database', id: 'migration' },
        { label: 'Mgmt Review', href: '/reviews', icon: 'clipboard-check', id: 'reviews' }
      ]
    },
    {
      id: 'analytics',
      label: 'Analytics',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
      color: 'amber',
      items: [
        { label: 'KPIs', href: '/kpis', icon: 'chart-bar', id: 'kpis' },
        { label: 'Executive', href: '/executive', icon: 'office-building', id: 'executive' },
        { label: 'System Logs', href: '/logs', icon: 'document-report', id: 'logs' }
      ]
    },
    {
      id: 'value',
      label: 'Value',
      icon: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      color: 'green',
      items: [
        { label: 'ROI & NPV', href: '/roi', icon: 'currency-dollar', id: 'roi' },
        { label: 'Team Performance', href: '/team', icon: 'user-group', id: 'team' },
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
        { label: 'Admin', href: '/admin', icon: 'cog', id: 'admin' },
        { label: 'Users & Access', href: '/users', icon: 'users', id: 'users' },
        { label: 'Scope of Work', href: '/docs/SCOPE_OF_WORK.html', icon: 'document', id: 'scope', external: true },
        { label: "Mohammed's SOW", href: '/mohammed-sow', icon: 'document', id: 'mohammed-sow' }
      ]
    }
  ],

  getColorClasses(color) {
    const colors = {
      blue: { bg: 'bg-blue-600', hover: 'hover:bg-blue-700', text: 'text-blue-600', lightBg: 'bg-blue-50' },
      slate: { bg: 'bg-slate-700', hover: 'hover:bg-slate-800', text: 'text-slate-700', lightBg: 'bg-slate-50' },
      amber: { bg: 'bg-amber-600', hover: 'hover:bg-amber-700', text: 'text-amber-600', lightBg: 'bg-amber-50' },
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
    const severityColors = { critical: 'bg-red-100 text-red-700', high: 'bg-orange-100 text-orange-700', medium: 'bg-yellow-100 text-yellow-700', low: 'bg-blue-100 text-blue-700' };
    const updateBadge = () => {
      fetch('/api/consultant/alerts/count', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : { count: 0 })
        .then(data => {
          const badge = document.getElementById('nav-alert-badge');
          if (!badge) return;
          if (data.count > 0) {
            badge.textContent = data.count > 99 ? '99+' : String(data.count);
            badge.classList.remove('hidden');
          } else {
            badge.classList.add('hidden');
          }
        })
        .catch(() => {});
      fetch('/api/consultant/alerts?limit=5&status=new', { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : { alerts: [] })
        .then(data => {
          const list = document.getElementById('nav-alert-list');
          if (!list) return;
          const alerts = data.alerts || [];
          if (alerts.length === 0) {
            list.innerHTML = '<div class="px-4 py-3 text-xs text-gray-400 text-center">No new alerts</div>';
            return;
          }
          list.innerHTML = alerts.map(a => {
            const sc = severityColors[a.severity] || severityColors.low;
            const ago = WalaPlusNav.timeAgo(a.created_at);
            return '<a href="/consultant" class="flex items-start gap-2 px-4 py-2 hover:bg-gray-50 border-b border-gray-50 last:border-0" data-testid="alert-item-' + a.id + '">' +
              '<span class="mt-0.5 inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded ' + sc + '">' + (a.severity || 'info').toUpperCase() + '</span>' +
              '<div class="flex-1 min-w-0"><p class="text-xs font-medium text-gray-800 truncate">' + WalaPlusNav.escapeHtml(a.title || '') + '</p>' +
              '<p class="text-[10px] text-gray-400">' + ago + '</p></div></a>';
          }).join('');
        })
        .catch(() => {});
    };
    updateBadge();
    setInterval(updateBadge, 60000);
  },

  timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
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
              <button class="flex items-center space-x-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition" data-testid="button-user-menu">
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

    navContainer.innerHTML = `
      <nav class="bg-white shadow-sm border-b border-gray-200 walaplus-nav">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div class="flex justify-between h-16 items-center">
            <a href="/" class="flex items-center flex-shrink-0">
              <div class="flex flex-col whitespace-nowrap">
                <span class="text-2xl font-bold text-indigo-600">WalaPlus</span>
                <span class="text-xs text-gray-500 -mt-1">Enterprise GRC & Quality Platform</span>
              </div>
            </a>
            
            <div class="flex items-center space-x-1">
              ${this.navigationGroups.map(group => this.renderDropdown(group)).join('')}
              
              <div class="hidden sm:flex items-center space-x-2 border-l border-gray-200 pl-3 ml-2">
                <span id="lastUpdated" class="text-xs text-gray-400"></span>
                <button onclick="typeof refreshDashboard === 'function' && refreshDashboard()" class="bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 transition flex items-center space-x-1 text-sm">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                  <span>Refresh</span>
                </button>
                <div id="nav-alert-bell" class="relative nav-dropdown" data-group="alerts-dropdown">
                  <button class="relative p-1 text-gray-500 hover:text-indigo-600 transition" data-testid="button-alert-bell" title="AI Alerts">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>
                    <span id="nav-alert-badge" class="hidden absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold" style="font-size:10px"></span>
                  </button>
                  <div class="dropdown-menu hidden absolute right-0 top-full mt-1 w-80 bg-white rounded-xl shadow-lg border border-gray-200 z-50">
                    <div class="px-4 py-2 border-b border-gray-100 flex justify-between items-center">
                      <span class="text-sm font-semibold text-gray-900">Notifications</span>
                      <a href="/consultant" class="text-xs text-indigo-600 hover:underline" data-testid="link-view-all-alerts">View all</a>
                    </div>
                    <div id="nav-alert-list" class="max-h-64 overflow-y-auto">
                      <div class="px-4 py-3 text-xs text-gray-400 text-center">Loading...</div>
                    </div>
                  </div>
                </div>
                <div id="nav-user-info" class="flex items-center space-x-2 border-l border-gray-200 pl-3 ml-1"></div>
              </div>
            </div>
            
            <button id="mobile-menu-btn" class="sm:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
              </svg>
            </button>
          </div>
        </div>
        
        <div id="mobile-menu" class="sm:hidden hidden bg-white border-t border-gray-200">
          <div class="px-4 py-3 space-y-2">
            ${this.navigationGroups.map(group => this.renderMobileGroup(group)).join('')}
          </div>
        </div>
      </nav>
    `;
  },

  renderDropdown(group) {
    const colors = this.getColorClasses(group.color);
    const isActive = this.isInGroup(group.id);
    
    return `
      <div class="relative nav-dropdown" data-group="${this.escapeHtml(group.id)}">
        <button class="flex items-center space-x-1 px-3 py-2 rounded-lg transition text-sm font-medium
          ${isActive ? `${colors.bg} text-white` : `text-gray-600 hover:bg-gray-100`}">
          ${group.icon}
          <span>${this.escapeHtml(group.label)}</span>
          <svg class="w-3 h-3 transition-transform dropdown-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
        <div class="dropdown-menu absolute left-0 mt-1 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50 hidden">
          ${group.items.map(item => this.renderDropdownItem(item, colors)).join('')}
        </div>
      </div>
    `;
  },

  renderDropdownItem(item, colors) {
    const isActive = item.id === this.currentPage;
    const target = item.external ? 'target="_blank"' : '';
    
    return `
      <a href="${this.escapeHtml(item.href)}" ${target} class="flex items-center space-x-2 px-4 py-2 text-sm transition
        ${isActive ? `${colors.lightBg} ${colors.text} font-medium` : 'text-gray-700 hover:bg-gray-50'}">
        ${this.getItemIcon(item.icon)}
        <span>${this.escapeHtml(item.label)}</span>
        ${item.external ? '<svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>' : ''}
      </a>
    `;
  },

  renderMobileGroup(group) {
    const colors = this.getColorClasses(group.color);
    const isActive = this.isInGroup(group.id);
    
    return `
      <div class="mobile-nav-group">
        <button class="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium
          ${isActive ? `${colors.lightBg} ${colors.text}` : 'text-gray-700 hover:bg-gray-50'}"
          onclick="WalaPlusNav.toggleMobileGroup(this)">
          <div class="flex items-center space-x-2">
            ${group.icon}
            <span>${this.escapeHtml(group.label)}</span>
          </div>
          <svg class="w-4 h-4 transition-transform mobile-arrow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
        <div class="mobile-submenu hidden pl-4 mt-1 space-y-1">
          ${group.items.map(item => `
            <a href="${this.escapeHtml(item.href)}" ${item.external ? 'target="_blank"' : ''} 
              class="flex items-center space-x-2 px-3 py-2 rounded-lg text-sm
                ${item.id === this.currentPage ? `${colors.lightBg} ${colors.text} font-medium` : 'text-gray-600 hover:bg-gray-50'}">
              ${this.getItemIcon(item.icon)}
              <span>${this.escapeHtml(item.label)}</span>
            </a>
          `).join('')}
        </div>
      </div>
    `;
  },

  bindEvents() {
    document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
      const btn = dropdown.querySelector('button');
      const menu = dropdown.querySelector('.dropdown-menu');
      const arrow = dropdown.querySelector('.dropdown-arrow');
      
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !menu.classList.contains('hidden');
        this.closeAllDropdowns();
        if (!isOpen) {
          menu.classList.remove('hidden');
          arrow.classList.add('rotate-180');
        }
      });
      
      dropdown.addEventListener('mouseenter', () => {
        if (window.innerWidth >= 640) {
          menu.classList.remove('hidden');
          arrow.classList.add('rotate-180');
        }
      });
      
      dropdown.addEventListener('mouseleave', () => {
        if (window.innerWidth >= 640) {
          menu.classList.add('hidden');
          arrow.classList.remove('rotate-180');
        }
      });
    });
    
    document.addEventListener('click', () => this.closeAllDropdowns());
    
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileBtn && mobileMenu) {
      mobileBtn.addEventListener('click', () => {
        mobileMenu.classList.toggle('hidden');
      });
    }
  },

  closeAllDropdowns() {
    document.querySelectorAll('.nav-dropdown .dropdown-menu').forEach(menu => {
      menu.classList.add('hidden');
    });
    document.querySelectorAll('.nav-dropdown .dropdown-arrow').forEach(arrow => {
      arrow.classList.remove('rotate-180');
    });
  },

  toggleMobileGroup(btn) {
    const submenu = btn.nextElementSibling;
    const arrow = btn.querySelector('.mobile-arrow');
    submenu.classList.toggle('hidden');
    arrow.classList.toggle('rotate-180');
  }
};

window.WalaPlusNav = WalaPlusNav;
