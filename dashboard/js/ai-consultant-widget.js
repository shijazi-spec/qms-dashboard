(function() {
    if (document.getElementById('ai-consultant-widget')) return;
    if (window.location.pathname.includes('consultant.html')) return;

    // i18n helper — resolves from WalaPlusI18n if available, else falls back to English literal
    function _t(key, fallback) {
        if (window.WalaPlusI18n && typeof window.WalaPlusI18n.t === 'function') {
            var val = window.WalaPlusI18n.t(key);
            // t() returns last key segment when key is missing; treat as untranslated
            if (val && val !== key.split('.').pop()) return val;
        }
        return fallback;
    }

    var threadId = sessionStorage.getItem('widget_consultant_threadId') || '';
    var isOpen = false;
    var isStreaming = false;
    var lastMessage = '';
    var chatMessages = [];

    function getThreadId() {
        if (!threadId) {
            threadId = 'thread_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
            sessionStorage.setItem('widget_consultant_threadId', threadId);
        }
        return threadId;
    }

    function isArabic(text) {
        var arabicRe = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
        var arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
        return arabicRe.test(text) && arabicChars > text.length * 0.3;
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function sanitizeUrl(url) {
        try {
            var u = url.trim();
            if (/^(https?:|mailto:|\/)/i.test(u)) return u;
            if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '#';
            return u;
        } catch (e) { return '#'; }
    }

    function formatInline(text) {
        text = escapeHtml(text);
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, label, url) {
            return '<a href="' + sanitizeUrl(url) + '" target="_blank" rel="noopener" class="aiw-link">' + label + '</a>';
        });
        text = text.replace(/`([^`]+)`/g, '<code class="aiw-code-inline">$1</code>');
        return text;
    }

    function renderMarkdown(text) {
        var codeBlocks = [];
        var html = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
            var idx = codeBlocks.length;
            codeBlocks.push('<pre class="aiw-code-block"><code>' + escapeHtml(code.trim()) + '</code></pre>');
            return '%%CODEBLOCK_' + idx + '%%';
        });

        var lines = html.split('\n');
        var result = [];
        var inList = false;
        var listTag = ''; // 'ul' or 'ol' — close with matching tag
        function closeList() {
            if (inList) { result.push('</' + listTag + '>'); inList = false; listTag = ''; }
        }
        function ensureList(tag) {
            if (inList && listTag === tag) return;
            closeList();
            result.push('<' + tag + ' class="aiw-list">');
            inList = true;
            listTag = tag;
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.match(/^%%CODEBLOCK_\d+%%$/)) {
                closeList();
                result.push(line);
            } else if (line.match(/^#{1,3}\s/)) {
                closeList();
                var level = line.match(/^(#{1,3})/)[1].length;
                result.push('<p class="aiw-heading-' + level + '">' + formatInline(line.replace(/^#{1,3}\s*/, '')) + '</p>');
            } else if (line.match(/^[\-\*]\s/)) {
                ensureList('ul');
                result.push('<li class="aiw-list-item">' + formatInline(line.replace(/^[\-\*]\s*/, '')) + '</li>');
            } else if (line.match(/^\d+\.\s/)) {
                ensureList('ol');
                result.push('<li class="aiw-list-item">' + formatInline(line.replace(/^\d+\.\s*/, '')) + '</li>');
            } else if (line.trim() === '') {
                closeList();
                result.push('<br>');
            } else {
                closeList();
                result.push('<p class="aiw-paragraph">' + formatInline(line) + '</p>');
            }
        }
        closeList();

        html = result.join('\n');
        // Merge adjacent same-type lists so Adam's "1. … \n\n 1. … \n\n 1. …"
        // pattern (every item labelled "1." with blank lines between) shows
        // as 1, 2, 3, 4, 5 instead of five "1." items each in their own
        // restart-at-1 <ol>. Same fix as the consultant.html renderer.
        html = html.replace(/<\/ol>\s*(?:<br>\s*)*<ol class="aiw-list">/g, '');
        html = html.replace(/<\/ul>\s*(?:<br>\s*)*<ul class="aiw-list">/g, '');
        for (var j = 0; j < codeBlocks.length; j++) {
            html = html.replace('%%CODEBLOCK_' + j + '%%', codeBlocks[j]);
        }
        return html;
    }

    // Resolve a CSP nonce so the injected <style> below is authorized under the
    // strict nonce-based style-src. document.currentScript.nonce is unreliable
    // for async dynamically-inserted scripts, so fall back to the nonce shared
    // by navigation.js and finally to any nonce-bearing element already on the
    // page.
    function _resolveWidgetNonce() {
        var n = (document.currentScript && document.currentScript.nonce) || '';
        if (n) return n;
        if (window.WALAPLUS_NAV_NONCE) return window.WALAPLUS_NAV_NONCE;
        var el = document.querySelector('script[nonce], style[nonce]');
        return (el && (el.nonce || el.getAttribute('nonce'))) || '';
    }
    var widgetNonce = _resolveWidgetNonce();
    var style = document.createElement('style');
    if (widgetNonce) style.setAttribute('nonce', widgetNonce);
    style.textContent = `
        #ai-consultant-widget { position: fixed; bottom: 24px; right: 24px; z-index: 99999; font-family: 'Inter', 'Noto Sans Arabic', sans-serif; }
        #ai-widget-btn {
            width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
            background: linear-gradient(135deg, #4f46e5, #7c3aed);
            box-shadow: 0 4px 14px rgba(79, 70, 229, 0.4);
            display: flex; align-items: center; justify-content: center;
            transition: all 0.3s ease; position: relative;
        }
        #ai-widget-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(79, 70, 229, 0.5); }
        #ai-widget-btn svg { width: 26px; height: 26px; color: white; }
        .widget-feedback-bar { display:flex; align-items:center; gap:4px; margin-top:5px; }
        .widget-feedback-thumb {
            display:inline-flex; align-items:center; justify-content:center;
            width:22px; height:22px; border-radius:5px; border:1px solid #e2e8f0;
            background:#f8fafc; cursor:pointer; color:#94a3b8; transition:all 0.15s;
        }
        .widget-feedback-thumb:hover { background:#eef2ff; border-color:#c7d2fe; color:#4f46e5; }
        .widget-feedback-thumb.up-selected { background:#dcfce7; border-color:#86efac; color:#16a34a; }
        .widget-feedback-thumb.down-selected { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
        .widget-feedback-thumb svg { width:11px; height:11px; }
        .widget-feedback-label { font-size:10px; color:#94a3b8; }
        .widget-feedback-thanks { font-size:10px; color:#16a34a; display:none; }
        #widget-down-modal {
            position:fixed; inset:0; z-index:100001; display:flex; align-items:flex-end; justify-content:center;
            background:rgba(0,0,0,0.35);
        }
        #widget-down-modal.hidden { display:none; }
        .widget-down-box {
            background:white; border-radius:16px 16px 0 0; padding:20px; width:100%; max-width:420px;
            box-shadow:0 -8px 30px rgba(0,0,0,0.15);
        }
        .widget-cat-btn {
            display:inline-block; padding:4px 10px; border-radius:20px; font-size:11px;
            border:1px solid #e2e8f0; background:#f8fafc; color:#64748b; cursor:pointer; margin:2px;
            transition:all 0.15s;
        }
        .widget-cat-btn.sel { border-color:#ef4444; background:#fee2e2; color:#dc2626; }
        .widget-down-header {
            display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;
        }
        .widget-down-title { font-size:14px; color:#1e293b; }
        .widget-down-close {
            background:none; border:none; cursor:pointer; color:#94a3b8; font-size:18px;
        }
        .widget-down-cats { margin-bottom:12px; }
        .widget-down-comment {
            width:100%; border:1px solid #e2e8f0; border-radius:8px; padding:8px;
            font-size:12px; resize:none; box-sizing:border-box; margin-bottom:10px;
        }
        .widget-down-footer { display:flex; justify-content:flex-end; gap:8px; }
        .widget-down-skip {
            padding:6px 14px; border:1px solid #e2e8f0; border-radius:8px; background:white;
            font-size:12px; cursor:pointer; color:#64748b;
        }
        .widget-down-submit {
            padding:6px 14px; border:none; border-radius:8px; background:#dc2626; color:white;
            font-size:12px; cursor:pointer; font-weight:500;
        }
        #ai-widget-panel {
            display: none; position: absolute; bottom: 70px; right: 0;
            width: 380px; max-height: 520px; background: white;
            border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.15);
            overflow: hidden; flex-direction: column;
        }
        #ai-widget-panel.open { display: flex; }
        #ai-widget-header {
            background: linear-gradient(135deg, #4f46e5, #7c3aed);
            padding: 14px 16px; display: flex; align-items: center; justify-content: space-between;
        }
        #ai-widget-header h3 { color: white; font-size: 14px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
        #ai-widget-header button { background: none; border: none; color: rgba(255,255,255,0.8); cursor: pointer; padding: 4px; border-radius: 4px; }
        #ai-widget-header button:focus-visible { outline: 3px solid rgba(255,255,255,0.8); outline-offset: 2px; }
        #ai-widget-header button:hover { color: white; }
        #ai-widget-messages {
            flex: 1; overflow-y: auto; padding: 16px; min-height: 300px; max-height: 360px;
            scrollbar-width: thin; scrollbar-color: #c7d2fe #f1f5f9;
        }
        #ai-widget-messages::-webkit-scrollbar { width: 5px; }
        #ai-widget-messages::-webkit-scrollbar-track { background: #f8fafc; }
        #ai-widget-messages::-webkit-scrollbar-thumb { background: #c7d2fe; border-radius: 3px; }
        .widget-msg-user { display: flex; justify-content: flex-end; margin-bottom: 10px; }
        .widget-msg-user .bubble { background: #4f46e5; color: white; border-radius: 14px 14px 4px 14px; padding: 10px 14px; max-width: 80%; font-size: 13px; line-height: 1.5; }
        .widget-msg-ai { display: flex; justify-content: flex-start; gap: 8px; margin-bottom: 10px; align-items: flex-start; }
        .widget-msg-ai .avatar {
            width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0; margin-top: 2px;
            background: linear-gradient(135deg, #4f46e5, #7c3aed);
            display: flex; align-items: center; justify-content: center;
        }
        .widget-msg-ai .avatar svg { width: 14px; height: 14px; color: white; }
        .widget-msg-ai .bubble { background: #f1f5f9; border-radius: 14px 14px 14px 4px; padding: 10px 14px; max-width: 80%; font-size: 13px; line-height: 1.6; color: #1e293b; }
        .widget-typing { display: none; gap: 8px; align-items: flex-start; margin-bottom: 10px; }
        .widget-typing .dot { width: 6px; height: 6px; border-radius: 50%; background: #94a3b8; display: inline-block; margin: 0 2px; }
        .widget-typing .dot:nth-child(1) { animation: wdot 1.2s infinite 0s; }
        .widget-typing .dot:nth-child(2) { animation: wdot 1.2s infinite 0.2s; }
        .widget-typing .dot:nth-child(3) { animation: wdot 1.2s infinite 0.4s; }
        @keyframes wdot { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-5px)} }
        #ai-widget-input-area {
            border-top: 1px solid #e2e8f0; padding: 10px 12px; display: flex; gap: 8px; align-items: flex-end; background: #fafbfc;
        }
        #ai-widget-input {
            flex: 1; border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px 12px;
            font-size: 13px; resize: none; outline: none; font-family: inherit;
            max-height: 80px; min-height: 36px; line-height: 1.4;
        }
        #ai-widget-input:focus { border-color: #a5b4fc; box-shadow: 0 0 0 2px rgba(165,180,252,0.3); }
        #ai-widget-send {
            width: 36px; height: 36px; border-radius: 50%; border: none; cursor: pointer;
            background: #4f46e5; display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; transition: opacity 0.2s;
        }
        #ai-widget-send:disabled { opacity: 0.4; cursor: not-allowed; }
        #ai-widget-send svg { width: 16px; height: 16px; color: white; }
        #ai-widget-welcome { text-align: center; padding: 20px 16px; }
        #ai-widget-welcome h4 { font-size: 15px; font-weight: 600; color: #1e293b; margin: 0 0 6px; }
        #ai-widget-welcome p { font-size: 12px; color: #64748b; margin: 0 0 14px; }
        .widget-quick-btn {
            display: inline-block; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px;
            padding: 6px 12px; font-size: 11px; color: #4f46e5; cursor: pointer;
            margin: 3px; transition: all 0.15s;
        }
        .widget-quick-btn:hover { background: #eef2ff; border-color: #c7d2fe; }
        @media (max-width: 480px) {
            #ai-widget-panel { width: calc(100vw - 32px); right: -8px; bottom: 64px; max-height: 70vh; }
        }
        .widget-expand-link {
            font-size: 11px; color: #6366f1; text-decoration: none; display: flex; align-items: center; gap: 4px;
        }
        .widget-expand-link:hover { text-decoration: underline; }
    `;
    document.head.appendChild(style);

    var widget = document.createElement('div');
    widget.id = 'ai-consultant-widget';

    // Build translated widget HTML — called once at init and again after i18n loads
    function buildWidgetHTML() {
        var widgetTitle    = _t('consultant.widget_title',       'Adam');
        var fullView       = _t('consultant.full_view',          'Full view');
        var welcomeTitle   = _t('consultant.widget_welcome_title','Adam');
        var welcomeSub     = _t('consultant.widget_welcome_sub', 'Ask about quality management, compliance, CRM data hygiene, or SOPs.');
        var qQuality       = _t('consultant.quick_quality',      'Quality Score');
        var qCompliance    = _t('consultant.quick_compliance',   'Compliance');
        var qCrm           = _t('consultant.quick_crm',          'CRM Issues');
        var qIso           = _t('consultant.quick_iso',          'ISO 9001');
        var placeholder    = _t('consultant.widget_placeholder', 'Ask anything...');

        return `
        <div id="ai-widget-panel">
            <div id="ai-widget-header">
                <h3>
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" class="icon-18"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
                    ${widgetTitle}
                </h3>
                <div class="aiw-header-row">
                    <a href="/consultant.html" target="_blank" rel="noopener" class="widget-expand-link" data-testid="link-expand-consultant">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" class="icon-14"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
                        ${fullView}
                    </a>
                    <button data-on-click="aiWidgetClose" aria-label="Close Adam chat" data-testid="button-close-widget">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" class="icon-18" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>
            <div id="ai-widget-messages" role="log" aria-live="polite" aria-label="Adam conversation" aria-relevant="additions">
                <div id="ai-widget-welcome">
                    <h4 data-i18n="consultant.widget_welcome_title">${welcomeTitle}</h4>
                    <p data-i18n="consultant.widget_welcome_sub">${welcomeSub}</p>
                    <div>
                        <button type="button" class="widget-quick-btn" data-on-click="widgetQuickSend" data-args="[&quot;What is our current quality score?&quot;]" data-testid="button-quick-quality" data-i18n="consultant.quick_quality">${qQuality}</button>
                        <button type="button" class="widget-quick-btn" data-on-click="widgetQuickSend" data-args="[&quot;Show compliance status&quot;]" data-testid="button-quick-compliance" data-i18n="consultant.quick_compliance">${qCompliance}</button>
                        <button type="button" class="widget-quick-btn" data-on-click="widgetQuickSend" data-args="[&quot;What are the top CRM issues?&quot;]" data-testid="button-quick-crm" data-i18n="consultant.quick_crm">${qCrm}</button>
                        <button type="button" class="widget-quick-btn" data-on-click="widgetQuickSend" data-args="[&quot;Explain ISO 9001 requirements&quot;]" data-testid="button-quick-iso" data-i18n="consultant.quick_iso">${qIso}</button>
                    </div>
                </div>
                <div class="widget-typing" id="ai-widget-typing">
                    <div class="aiw-avatar">
                        <svg fill="none" stroke="white" viewBox="0 0 24 24" class="icon-14"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
                    </div>
                    <div class="aiw-bubble-bot">
                        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                    </div>
                </div>
            </div>
            <div id="ai-widget-input-area">
                <textarea id="ai-widget-input" placeholder="${placeholder}" rows="1" aria-label="Type your question" data-testid="input-widget-chat"></textarea>
                <button id="ai-widget-send" disabled aria-label="Send message" data-testid="button-widget-send">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/></svg>
                </button>
            </div>
        </div>
        <button id="ai-widget-btn" aria-label="Open Adam chat" aria-expanded="false" aria-controls="ai-widget-panel" data-testid="button-ai-consultant">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
        </button>
        `;
    }

    widget.innerHTML = buildWidgetHTML();
    document.body.appendChild(widget);

    var btn = document.getElementById('ai-widget-btn');
    var panel = document.getElementById('ai-widget-panel');
    var messagesEl = document.getElementById('ai-widget-messages');
    var inputEl = document.getElementById('ai-widget-input');
    var sendBtn = document.getElementById('ai-widget-send');
    var typingEl = document.getElementById('ai-widget-typing');

    function setWidgetOpen(open) {
        isOpen = open;
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        btn.setAttribute('aria-label', isOpen ? 'Close Adam chat' : 'Open Adam chat');
        if (isOpen) {
            panel.classList.add('open');
            panel.setAttribute('aria-hidden', 'false');
            inputEl.focus();
        } else {
            panel.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
            btn.focus();
        }
    }

    window._closeAIWidget = function() { setWidgetOpen(false); };
    // Opened by the global header 🤖 Adam button (WalaPlusNav.openAssistant).
    window._openAIWidget = function() {
        setWidgetOpen(true);
        widgetLoadThreadHistory();
    };

    /**
     * Re-hydrate the widget transcript from the server when the user
     * returns to a page (or opens the widget after a refresh). Uses the
     * threadId persisted in sessionStorage under widget_consultant_threadId
     * so the conversation — including feedback bars on assistant turns —
     * survives page reloads. Loaded lazily on first widget open to avoid
     * a wasted request on pages where the user never opens the chat.
     * Mirrors loadThreadHistory() on the full consultant page.
     */
    // Tracks whether the history fetch has *successfully* completed
    // for this page load. We deliberately flip this flag only after
    // a successful fetch (not before) so that a transient network or
    // server failure on the first widget open still allows a retry the
    // next time the user opens the widget within the same session.
    var widgetHistoryLoaded = false;
    var widgetHistoryInflight = false;
    async function widgetLoadThreadHistory() {
        if (widgetHistoryLoaded || widgetHistoryInflight) return;
        var tid = sessionStorage.getItem('widget_consultant_threadId');
        if (!tid) return;
        widgetHistoryInflight = true;
        try {
            var res = await fetch('/api/consultant/history/' + encodeURIComponent(tid), {
                credentials: 'same-origin'
            });
            if (!res.ok) return;
            var data = await res.json();
            var msgs = (data && data.messages) || [];
            widgetHistoryLoaded = true;
            if (!msgs.length) return;
            threadId = tid;
            var pv = data.promptVersion || null;
            var welcome = document.getElementById('ai-widget-welcome');
            if (welcome) welcome.remove();
            msgs.forEach(function(m) {
                if (m.role === 'user') {
                    widgetAppendUser(m.content);
                } else if (m.role === 'assistant') {
                    var bubble = widgetCreateAI();
                    bubble.innerHTML = renderMarkdown(m.content);
                    // dir="auto" is already set by widgetCreateAI — let the
                    // browser pick LTR / RTL from the rendered content.
                    chatMessages.push({ role: 'assistant', content: m.content, time: m.createdAt || new Date().toISOString() });
                    if (m.messageId && m.content && m.content.trim()) {
                        widgetAttachFeedback(bubble, m.messageId, '', m.content, pv);
                    }
                }
            });
            widgetScrollBottom();
        } catch (e) {
            /* best-effort: failures fall back to empty welcome */
        } finally {
            widgetHistoryInflight = false;
        }
    }

    btn.addEventListener('click', function() {
        setWidgetOpen(!isOpen);
        if (isOpen) widgetLoadThreadHistory();
    });

    inputEl.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 80) + 'px';
        sendBtn.disabled = !this.value.trim() || isStreaming;
    });

    inputEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!sendBtn.disabled) widgetSendMessage(inputEl.value.trim());
        }
    });

    sendBtn.addEventListener('click', function() {
        var msg = inputEl.value.trim();
        if (msg && !isStreaming) widgetSendMessage(msg);
    });

    window.widgetQuickSend = function(text) {
        var welcome = document.getElementById('ai-widget-welcome');
        if (welcome) welcome.remove();
        widgetSendMessage(text);
    };

    // Re-apply translations after WalaPlusI18n has fully loaded (async)
    function applyWidgetTranslations() {
        var header = widget.querySelector('#ai-widget-header h3');
        if (header) {
            var svgEl = header.querySelector('svg');
            var svgHTML = svgEl ? svgEl.outerHTML : '';
            header.innerHTML = svgHTML + ' ' + _t('consultant.widget_title', 'Adam');
        }
        var expandLink = widget.querySelector('.widget-expand-link');
        if (expandLink) {
            var svgEl2 = expandLink.querySelector('svg');
            var svgHTML2 = svgEl2 ? svgEl2.outerHTML : '';
            expandLink.innerHTML = svgHTML2 + ' ' + _t('consultant.full_view', 'Full view');
            // Open the full conversation in a NEW TAB (Sarah 2026-06-18) so the
            // page the widget is floating over (e.g. Duplicates Radar) isn't
            // lost. Carry the CURRENT widget conversation across via ?thread= so
            // it doesn't "disappear" on expand — the full page adopts it.
            expandLink.addEventListener('click', function (e) {
                e.preventDefault();
                var tid = sessionStorage.getItem('widget_consultant_threadId');
                var url = tid
                    ? '/consultant.html?thread=' + encodeURIComponent(tid)
                    : '/consultant.html';
                window.open(url, '_blank', 'noopener');
            });
        }
        var wTitle = widget.querySelector('#ai-widget-welcome h4');
        if (wTitle) wTitle.textContent = _t('consultant.widget_welcome_title', 'Adam');
        var wSub = widget.querySelector('#ai-widget-welcome p');
        if (wSub) wSub.textContent = _t('consultant.widget_welcome_sub', 'Ask about quality management, compliance, CRM data hygiene, or SOPs.');
        var qBtnSpecs = [
            { tid: 'button-quick-quality',    label: function(fb) { return _t('consultant.quick_quality', fb); } },
            { tid: 'button-quick-compliance', label: function(fb) { return _t('consultant.quick_compliance', fb); } },
            { tid: 'button-quick-crm',        label: function(fb) { return _t('consultant.quick_crm', fb); } },
            { tid: 'button-quick-iso',        label: function(fb) { return _t('consultant.quick_iso', fb); } }
        ];
        qBtnSpecs.forEach(function(spec) {
            var el = widget.querySelector('[data-testid="' + spec.tid + '"]');
            if (el) el.textContent = spec.label(el.textContent);
        });
        var inp = widget.querySelector('#ai-widget-input');
        if (inp) inp.placeholder = _t('consultant.widget_placeholder', 'Ask anything...');
    }

    // If i18n loads after the widget, re-apply translations once it's ready
    if (window.WalaPlusI18n && typeof window.WalaPlusI18n.onReady === 'function') {
        window.WalaPlusI18n.onReady(applyWidgetTranslations);
    } else {
        document.addEventListener('walaPlusI18nReady', applyWidgetTranslations);
    }

    // CSP-safe close handler invoked via data-on-click="aiWidgetClose"
    window.aiWidgetClose = function() {
        var panel = document.getElementById('ai-widget-panel');
        if (panel) panel.classList.remove('open');
        if (typeof window._closeAIWidget === 'function') {
            try { window._closeAIWidget(); } catch (_) {}
        }
    };

    function widgetScrollBottom() {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function widgetAppendUser(text) {
        var welcome = document.getElementById('ai-widget-welcome');
        if (welcome) welcome.remove();
        var div = document.createElement('div');
        div.className = 'widget-msg-user';
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.setAttribute('dir', 'auto');
        bubble.textContent = text;
        div.appendChild(bubble);
        messagesEl.insertBefore(div, typingEl);
        widgetScrollBottom();
    }

    function widgetCreateAI() {
        var div = document.createElement('div');
        div.className = 'widget-msg-ai';
        div.innerHTML = '<div class="avatar"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg></div>';
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        // dir="auto" — browser picks LTR / RTL per-message from the first
        // strong character. Replaces three scattered isArabic() setters
        // that only handled the RTL case and let English bleed when the
        // host page was in Arabic mode.
        bubble.setAttribute('dir', 'auto');
        div.appendChild(bubble);
        messagesEl.insertBefore(div, typingEl);
        widgetScrollBottom();
        return bubble;
    }

    function widgetAttachFeedback(bubble, messageId, promptText, responseText, promptVersion) {
        if (!messageId || bubble.querySelector('.widget-feedback-bar')) return;
        var bar = document.createElement('div');
        bar.className = 'widget-feedback-bar';
        bar.innerHTML =
            '<button class="widget-feedback-thumb" title="Helpful" aria-label="Helpful">' +
              '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905C11 6.003 9.1 7.7 7 8v12m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"/></svg>' +
            '</button>' +
            '<button class="widget-feedback-thumb" title="Not helpful" aria-label="Not helpful">' +
              '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018c.163 0 .326.02.485.06L17 4m-7 10v2a2 2 0 002 2h.095c.5 0 .905-.405.905-.905C13 14.997 14.9 13.3 17 13V1m-7 13h2M17 4h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"/></svg>' +
            '</button>' +
            '<span class="widget-feedback-label">Helpful?</span>' +
            '<span class="widget-feedback-thanks">Thanks!</span>';

        var buttons = bar.querySelectorAll('.widget-feedback-thumb');
        var upBtn = buttons[0], downBtn = buttons[1];
        var label = bar.querySelector('.widget-feedback-label');
        var thanks = bar.querySelector('.widget-feedback-thanks');

        function markDone(rating) {
            upBtn.classList.toggle('up-selected', rating === 'up');
            downBtn.classList.toggle('down-selected', rating === 'down');
            label.style.display = 'none';
            thanks.style.display = 'inline';
        }

        upBtn.addEventListener('click', function() {
            widgetSubmitFeedback(messageId, 'up', null, null, promptText, responseText, markDone, promptVersion);
        });
        downBtn.addEventListener('click', function() {
            widgetOpenDownModal(messageId, promptText, responseText, markDone, promptVersion);
        });

        bubble.appendChild(bar);

        var cachedRating = wRatingCacheGet(messageId);
        if (cachedRating) {
            markDone(cachedRating);
        } else {
            fetch('/api/consultant/feedback/' + encodeURIComponent(messageId), {
                credentials: 'same-origin'
            }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
                if (data && data.rating) {
                    wRatingCacheSet(messageId, data.rating);
                    markDone(data.rating);
                }
            }).catch(function() {});
        }
    }

    var _wModalCb = null;

    function widgetOpenDownModal(messageId, promptText, responseText, onDone, promptVersion) {
        _wModalCb = { messageId: messageId, promptText: promptText, responseText: responseText, onDone: onDone, promptVersion: promptVersion };
        var modal = document.getElementById('widget-down-modal');
        if (!modal) {
            var m = document.createElement('div');
            m.id = 'widget-down-modal';
            m.setAttribute('role', 'dialog');
            m.setAttribute('aria-modal', 'true');
            m.setAttribute('aria-label', 'Feedback: What went wrong?');
            m.innerHTML =
                '<div class="widget-down-box">' +
                  '<div class="widget-down-header">' +
                    '<strong class="widget-down-title">What went wrong?</strong>' +
                    '<button type="button" data-on-click="widgetCloseDownModal" aria-label="Close" class="widget-down-close">✕</button>' +
                  '</div>' +
                  '<div id="widget-cats" class="widget-down-cats">' +
                    '<span class="widget-cat-btn" data-cat="incorrect">Incorrect</span>' +
                    '<span class="widget-cat-btn" data-cat="missing_context">Missing context</span>' +
                    '<span class="widget-cat-btn" data-cat="hallucinated">Hallucinated</span>' +
                    '<span class="widget-cat-btn" data-cat="off_policy">Off-policy</span>' +
                    '<span class="widget-cat-btn" data-cat="formatting">Formatting</span>' +
                    '<span class="widget-cat-btn" data-cat="other">Other</span>' +
                  '</div>' +
                  '<textarea id="widget-feedback-comment" rows="2" maxlength="500" placeholder="Optional: describe what went wrong" class="widget-down-comment"></textarea>' +
                  '<div class="widget-down-footer">' +
                    '<button type="button" data-on-click="widgetCloseDownModal" class="widget-down-skip">Skip</button>' +
                    '<button type="button" data-on-click="widgetSubmitDownModal" class="widget-down-submit">Submit</button>' +
                  '</div>' +
                '</div>';
            document.body.appendChild(m);
            m.querySelectorAll('.widget-cat-btn').forEach(function(b) {
                b.addEventListener('click', function() { b.classList.toggle('sel'); });
            });
            modal = m;
        } else {
            modal.querySelectorAll('.widget-cat-btn').forEach(function(b) { b.classList.remove('sel'); });
            var ta = modal.querySelector('#widget-feedback-comment');
            if (ta) ta.value = '';
            modal.classList.remove('hidden');
        }
    }

    window.widgetCloseDownModal = function() {
        var m = document.getElementById('widget-down-modal');
        if (m) m.classList.add('hidden');
        _wModalCb = null;
    };

    window.widgetSubmitDownModal = function() {
        if (!_wModalCb) return;
        var modal = document.getElementById('widget-down-modal');
        var cats = Array.from(modal.querySelectorAll('.widget-cat-btn.sel')).map(function(b) { return b.dataset.cat; }).join(',');
        var comment = (document.getElementById('widget-feedback-comment').value || '').trim();
        var cb = _wModalCb;
        widgetSubmitFeedback(cb.messageId, 'down', cats || null, comment || null, cb.promptText, cb.responseText, cb.onDone, cb.promptVersion);
        widgetCloseDownModal();
    };

    var W_FB_QUEUE_KEY = 'walaplus_feedback_queue';
    var W_RATING_CACHE_KEY = 'walaplus_msg_ratings';

    function wRatingCacheGet(messageId) {
        try { var m = JSON.parse(localStorage.getItem(W_RATING_CACHE_KEY) || '{}'); return m[messageId] || null; } catch(e) { return null; }
    }
    function wRatingCacheSet(messageId, rating) {
        try { var m = JSON.parse(localStorage.getItem(W_RATING_CACHE_KEY) || '{}'); m[messageId] = rating; localStorage.setItem(W_RATING_CACHE_KEY, JSON.stringify(m)); } catch(e) {}
    }

    function wFbQueueGet() {
        try { return JSON.parse(localStorage.getItem(W_FB_QUEUE_KEY) || '[]'); } catch(e) { return []; }
    }
    function wFbQueueSave(q) {
        try { localStorage.setItem(W_FB_QUEUE_KEY, JSON.stringify(q)); } catch(e) {}
    }
    function wFbQueueAdd(item) {
        var q = wFbQueueGet();
        var idx = q.findIndex(function(x) { return x.messageId === item.messageId; });
        if (idx >= 0) { q[idx] = item; } else { q.push(item); }
        wFbQueueSave(q);
    }
    function wFbQueueRemove(messageId) {
        wFbQueueSave(wFbQueueGet().filter(function(x) { return x.messageId !== messageId; }));
    }
    function wFbQueueDrain() {
        wFbQueueGet().forEach(function(item) {
            fetch('/api/consultant/feedback', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin', body: JSON.stringify(item)
            }).then(function(r) { if (r.ok) wFbQueueRemove(item.messageId); }).catch(function() {});
        });
    }
    setTimeout(wFbQueueDrain, 2000);

    function widgetSubmitFeedback(messageId, rating, category, comment, promptText, responseText, onDone, promptVersion) {
        if (onDone) onDone(rating);
        if (messageId) wRatingCacheSet(messageId, rating);
        var payload = {
            messageId: messageId,
            conversationId: threadId || null,
            rating: rating,
            category: category || null,
            comment: comment || null,
            promptPreview: promptText ? promptText.substring(0, 300) : null,
            responsePreview: responseText ? responseText.substring(0, 500) : null,
            promptVersion: promptVersion || null,
            ratingSource: 'inline_thumbs',
            clientSurface: 'web_widget',
        };
        wFbQueueAdd(payload);
        fetch('/api/consultant/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        }).then(function(r) {
            if (r.ok) wFbQueueRemove(messageId);
        }).catch(function() {
            var retries = 0;
            function retry() {
                retries++;
                var delay = Math.min(30000, 5000 * Math.pow(2, retries - 1));
                setTimeout(function() {
                    var item = wFbQueueGet().find(function(x) { return x.messageId === messageId; });
                    if (!item) return;
                    fetch('/api/consultant/feedback', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin', body: JSON.stringify(item)
                    }).then(function(r) {
                        if (r.ok) wFbQueueRemove(messageId);
                        else if (retries < 4) retry();
                    }).catch(function() { if (retries < 4) retry(); });
                }, delay);
            }
            retry();
        });
    }

    function widgetShowTyping() { typingEl.style.display = 'flex'; widgetScrollBottom(); }
    function widgetHideTyping() { typingEl.style.display = 'none'; }

    async function widgetSendMessage(text) {
        lastMessage = text;
        widgetAppendUser(text);
        inputEl.value = '';
        inputEl.style.height = 'auto';
        sendBtn.disabled = true;
        isStreaming = true;
        widgetShowTyping();

        var bubble = null;
        var fullText = '';
        var streamOk = false;
        var capturedMessageId = null;
        var capturedPromptVersion = null;

        try {
            var response = await fetch('/api/consultant/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ message: text, threadId: getThreadId() })
            });

            if (!response.ok) throw new Error('Stream error ' + response.status);

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            widgetHideTyping();
            bubble = widgetCreateAI();
            // dir="auto" is already set by widgetCreateAI.
            streamOk = true;
            var buffer = '';

            while (true) {
                var result = await reader.read();
                if (result.done) break;
                buffer += decoder.decode(result.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop();

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (line.startsWith('data: ')) {
                        var data = line.substring(6);
                        if (data === '[DONE]') continue;
                        try {
                            var parsed = JSON.parse(data);
                            if (parsed.threadId) {
                                threadId = parsed.threadId;
                                sessionStorage.setItem('widget_consultant_threadId', threadId);
                            }
                            if (parsed.messageId) { capturedMessageId = parsed.messageId; }
                            if (parsed.promptVersion) { capturedPromptVersion = parsed.promptVersion; }
                            if (parsed.text) { fullText += parsed.text; bubble.innerHTML = renderMarkdown(fullText); widgetScrollBottom(); }
                            if (parsed.content) { fullText += parsed.content; bubble.innerHTML = renderMarkdown(fullText); widgetScrollBottom(); }
                            if (parsed.error) { fullText += '\n\n**Error:** ' + parsed.error; bubble.innerHTML = renderMarkdown(fullText); }
                        } catch (pe) {
                            fullText += data;
                            bubble.innerHTML = renderMarkdown(fullText);
                            widgetScrollBottom();
                        }
                    }
                }
            }

            if (buffer.trim() && buffer.startsWith('data: ') && buffer.substring(6) !== '[DONE]') {
                fullText += buffer.substring(6);
                bubble.innerHTML = renderMarkdown(fullText);
            }

            if (capturedMessageId && fullText.trim()) {
                widgetAttachFeedback(bubble, capturedMessageId, text, fullText, capturedPromptVersion);
            }

        } catch (err) {
            if (!streamOk) {
                widgetHideTyping();
                try {
                    var fallback = await fetch('/api/consultant/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ message: text, threadId: getThreadId() })
                    });
                    var data = await fallback.json();
                    if (data.threadId) { threadId = data.threadId; sessionStorage.setItem('widget_consultant_threadId', threadId); }
                    bubble = widgetCreateAI();
                    var respText = data.response || data.message
                        || (data.details ? ('⚠️ ' + data.details) : (data.error ? ('⚠️ ' + data.error) : 'No response received.'));
                    bubble.innerHTML = renderMarkdown(respText);
                    if (data.messageId && respText.trim()) {
                        widgetAttachFeedback(bubble, data.messageId, text, respText, data.promptVersion);
                    }
                } catch (fallbackErr) {
                    bubble = widgetCreateAI();
                    bubble.innerHTML = '<span class="aiw-error-text">Unable to reach Adam. Please try again.</span>';
                }
            } else if (bubble && fullText.trim()) {
                fullText += '\n\n---\n*Response interrupted.*';
                bubble.innerHTML = renderMarkdown(fullText);
                if (capturedMessageId) widgetAttachFeedback(bubble, capturedMessageId, text, fullText, capturedPromptVersion);
            }
        } finally {
            widgetHideTyping();
            isStreaming = false;
            sendBtn.disabled = !inputEl.value.trim();
            widgetScrollBottom();
        }
    }
})();
