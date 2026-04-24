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
            return '<a href="' + sanitizeUrl(url) + '" target="_blank" rel="noopener" style="color:#4f46e5;text-decoration:underline;">' + label + '</a>';
        });
        text = text.replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:0.85em;">$1</code>');
        return text;
    }

    function renderMarkdown(text) {
        var codeBlocks = [];
        var html = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
            var idx = codeBlocks.length;
            codeBlocks.push('<pre style="background:#1e293b;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;font-size:0.8em;margin:8px 0;"><code>' + escapeHtml(code.trim()) + '</code></pre>');
            return '%%CODEBLOCK_' + idx + '%%';
        });

        var lines = html.split('\n');
        var result = [];
        var inList = false;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.match(/^%%CODEBLOCK_\d+%%$/)) {
                if (inList) { result.push('</ul>'); inList = false; }
                result.push(line);
            } else if (line.match(/^#{1,3}\s/)) {
                if (inList) { result.push('</ul>'); inList = false; }
                var level = line.match(/^(#{1,3})/)[1].length;
                var sizes = { 1: '1.1em', 2: '1em', 3: '0.95em' };
                result.push('<p style="font-weight:600;font-size:' + sizes[level] + ';margin:8px 0 4px;">' + formatInline(line.replace(/^#{1,3}\s*/, '')) + '</p>');
            } else if (line.match(/^[\-\*]\s/)) {
                if (!inList) { result.push('<ul style="margin:4px 0;padding-left:18px;">'); inList = true; }
                result.push('<li style="margin:2px 0;">' + formatInline(line.replace(/^[\-\*]\s*/, '')) + '</li>');
            } else if (line.match(/^\d+\.\s/)) {
                if (!inList) { result.push('<ol style="margin:4px 0;padding-left:18px;">'); inList = true; }
                result.push('<li style="margin:2px 0;">' + formatInline(line.replace(/^\d+\.\s*/, '')) + '</li>');
            } else if (line.trim() === '') {
                if (inList) { result.push('</ul>'); inList = false; }
                result.push('<br>');
            } else {
                if (inList) { result.push('</ul>'); inList = false; }
                result.push('<p style="margin:4px 0;">' + formatInline(line) + '</p>');
            }
        }
        if (inList) result.push('</ul>');

        html = result.join('\n');
        for (var j = 0; j < codeBlocks.length; j++) {
            html = html.replace('%%CODEBLOCK_' + j + '%%', codeBlocks[j]);
        }
        return html;
    }

    var style = document.createElement('style');
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
        var widgetTitle    = _t('consultant.widget_title',       'AI QMS Consultant');
        var fullView       = _t('consultant.full_view',          'Full view');
        var welcomeTitle   = _t('consultant.widget_welcome_title','WalaPlus QMS Consultant');
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
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width:18px;height:18px;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
                    ${widgetTitle}
                </h3>
                <div style="display:flex;align-items:center;gap:8px;">
                    <a href="/consultant.html" class="widget-expand-link" data-testid="link-expand-consultant">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width:14px;height:14px;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
                        ${fullView}
                    </a>
                    <button onclick="window._closeAIWidget && window._closeAIWidget();" aria-label="Close AI Consultant chat" data-testid="button-close-widget">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width:18px;height:18px;" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>
            <div id="ai-widget-messages" role="log" aria-live="polite" aria-label="AI Consultant conversation" aria-relevant="additions">
                <div id="ai-widget-welcome">
                    <h4 data-i18n="consultant.widget_welcome_title">${welcomeTitle}</h4>
                    <p data-i18n="consultant.widget_welcome_sub">${welcomeSub}</p>
                    <div>
                        <button type="button" class="widget-quick-btn" onclick="widgetQuickSend('What is our current quality score?')" data-testid="button-quick-quality" data-i18n="consultant.quick_quality">${qQuality}</button>
                        <button type="button" class="widget-quick-btn" onclick="widgetQuickSend('Show compliance status')" data-testid="button-quick-compliance" data-i18n="consultant.quick_compliance">${qCompliance}</button>
                        <button type="button" class="widget-quick-btn" onclick="widgetQuickSend('What are the top CRM issues?')" data-testid="button-quick-crm" data-i18n="consultant.quick_crm">${qCrm}</button>
                        <button type="button" class="widget-quick-btn" onclick="widgetQuickSend('Explain ISO 9001 requirements')" data-testid="button-quick-iso" data-i18n="consultant.quick_iso">${qIso}</button>
                    </div>
                </div>
                <div class="widget-typing" id="ai-widget-typing">
                    <div class="avatar" style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                        <svg fill="none" stroke="white" viewBox="0 0 24 24" style="width:14px;height:14px;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
                    </div>
                    <div style="background:#f1f5f9;border-radius:14px;padding:10px 16px;">
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
        <button id="ai-widget-btn" aria-label="Open AI Consultant chat" aria-expanded="false" aria-controls="ai-widget-panel" data-testid="button-ai-consultant">
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
        btn.setAttribute('aria-label', isOpen ? 'Close AI Consultant chat' : 'Open AI Consultant chat');
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

    btn.addEventListener('click', function() {
        setWidgetOpen(!isOpen);
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
            header.innerHTML = svgHTML + ' ' + _t('consultant.widget_title', 'AI QMS Consultant');
        }
        var expandLink = widget.querySelector('.widget-expand-link');
        if (expandLink) {
            var svgEl2 = expandLink.querySelector('svg');
            var svgHTML2 = svgEl2 ? svgEl2.outerHTML : '';
            expandLink.innerHTML = svgHTML2 + ' ' + _t('consultant.full_view', 'Full view');
        }
        var wTitle = widget.querySelector('#ai-widget-welcome h4');
        if (wTitle) wTitle.textContent = _t('consultant.widget_welcome_title', 'WalaPlus QMS Consultant');
        var wSub = widget.querySelector('#ai-widget-welcome p');
        if (wSub) wSub.textContent = _t('consultant.widget_welcome_sub', 'Ask about quality management, compliance, CRM data hygiene, or SOPs.');
        var qBtns = {
            'button-quick-quality':    'consultant.quick_quality',
            'button-quick-compliance': 'consultant.quick_compliance',
            'button-quick-crm':        'consultant.quick_crm',
            'button-quick-iso':        'consultant.quick_iso'
        };
        Object.keys(qBtns).forEach(function(tid) {
            var el = widget.querySelector('[data-testid="' + tid + '"]');
            if (el) el.textContent = _t(qBtns[tid], el.textContent);
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
        if (isArabic(text)) bubble.setAttribute('dir', 'rtl');
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
        div.appendChild(bubble);
        messagesEl.insertBefore(div, typingEl);
        widgetScrollBottom();
        return bubble;
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
            if (isArabic(text)) bubble.setAttribute('dir', 'rtl');
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
                    var respText = data.response || data.message || 'No response received.';
                    bubble.innerHTML = renderMarkdown(respText);
                } catch (fallbackErr) {
                    bubble = widgetCreateAI();
                    bubble.innerHTML = '<span style="color:#ef4444;">Unable to reach AI Consultant. Please try again.</span>';
                }
            } else if (bubble && fullText.trim()) {
                fullText += '\n\n---\n*Response interrupted.*';
                bubble.innerHTML = renderMarkdown(fullText);
            }
        } finally {
            widgetHideTyping();
            isStreaming = false;
            sendBtn.disabled = !inputEl.value.trim();
            widgetScrollBottom();
        }
    }
})();
