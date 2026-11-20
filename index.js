/**
 * 429 Auto Retry Extension for TauriTavern / SillyTavern (v1.1.0)
 * 拦截生成请求（含流式 SSE 首包错误检测），在遇到 Vertex AI / API 429
 * （及可选 502/503/529）错误时，按「Retry-After 优先 + 指数退避 + 随机抖动」自动重试。
 */
(() => {
    const MODULE_NAME = 'st_429_auto_retry';
    const GLOBAL_GUARD = '__ST_429_AUTO_RETRY_INSTALLED__';

    if (window[GLOBAL_GUARD]) {
        return;
    }
    window[GLOBAL_GUARD] = true;

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        maxRetries: 5,
        baseDelayMs: 2000,
        backoffFactor: 2,
        maxDelayMs: 30000,
        jitterPercent: 25,
        retryOnOverload: true,
        onlyVertex: false,
        showToast: true,
        debugLog: false,
    });

    // 匹配 TauriTavern / SillyTavern 生成请求路径
    const TARGET_PATH_PATTERNS = [
        /\/api\/backends\/chat-completions\/generate(?:\?|$)/i,
        /\/api\/backends\/text-completions\/generate(?:\?|$)/i,
        /\/api\/[^?#]*\/generate(?:\?|$)/i,
        /\/chat\/completions(?:\?|$)/i,
    ];

    // 识别 429 / Vertex RESOURCE_EXHAUSTED / 503 过载特征
    const RATE_LIMIT_TEXT_PATTERN =
        /(?:\bstatus\s*429\b|\bcode["'\s:=]+429\b|\bHTTP\s*429\b|\b429\b|RESOURCE_EXHAUSTED|Resource exhausted|Too Many Requests|Quota exceeded|rate[\s_-]?limit)/i;
    const OVERLOAD_TEXT_PATTERN =
        /(?:\bstatus\s*(?:502|503|529)\b|\bcode["'\s:=]+(?:502|503|529)\b|\b503\b|UNAVAILABLE|overloaded|Service Unavailable)/i;

    const stats = {
        attempts: 0,
        recovered: 0,
        failed: 0,
    };

    function getSTContext() {
        return window.SillyTavern?.getContext?.() ?? null;
    }

    function getSettings() {
        const ctx = getSTContext();
        if (!ctx || !ctx.extensionSettings) {
            return { ...DEFAULT_SETTINGS };
        }
        if (!ctx.extensionSettings[MODULE_NAME]) {
            ctx.extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        }
        const cfg = ctx.extensionSettings[MODULE_NAME];
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (cfg[k] === undefined || cfg[k] === null) {
                cfg[k] = v;
            }
        }
        return cfg;
    }

    function saveSettings() {
        const ctx = getSTContext();
        if (ctx?.saveSettingsDebounced) {
            ctx.saveSettingsDebounced();
        }
    }

    function logDebug(...args) {
        if (getSettings().debugLog) {
            console.log('[429-Auto-Retry]', ...args);
        }
    }

    function notify(type, message) {
        if (!getSettings().showToast) return;
        if (window.toastr && typeof window.toastr[type] === 'function') {
            window.toastr[type](message, '429 自动重试', {
                timeOut: 4000,
                preventDuplicates: false,
            });
        }
    }

    function updateStatsUI() {
        const el = document.getElementById('retry429_stats_text');
        if (el) {
            el.textContent = `本次会话：重试 ${stats.attempts} 次 / 成功 ${stats.recovered} 次 / 耗尽 ${stats.failed} 次`;
        }
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        if (input && typeof input.url === 'string') return input.url;
        return '';
    }

    function getRequestMethod(input, init) {
        const method = init?.method || (input && typeof input === 'object' ? input.method : 'GET');
        return String(method || 'GET').toUpperCase();
    }

    function isTargetRequest(input, init) {
        const method = getRequestMethod(input, init);
        if (method !== 'POST') return false;
        const url = getRequestUrl(input);
        return TARGET_PATH_PATTERNS.some((re) => re.test(url));
    }

    function isVertexRequest(init) {
        try {
            if (!init || typeof init.body !== 'string') return true;
            const parsed = JSON.parse(init.body);
            const src = String(parsed?.chat_completion_source || '').toLowerCase();
            return src === 'vertexai' || src.includes('vertex');
        } catch {
            return true;
        }
    }

    function parseRetryAfterMs(response, maxDelayMs) {
        const header = response.headers?.get?.('retry-after');
        if (!header) return null;

        const trimmed = header.trim();
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(Math.max(seconds * 1000, 500), maxDelayMs);
        }

        const dateMs = Date.parse(trimmed);
        if (Number.isFinite(dateMs)) {
            const delta = dateMs - Date.now();
            if (delta > 0) {
                return Math.min(Math.max(delta, 500), maxDelayMs);
            }
        }
        return null;
    }

    function computeDelayMs(attemptIndex, response, cfg) {
        const maxDelayMs = Math.max(1000, Number(cfg.maxDelayMs) || DEFAULT_SETTINGS.maxDelayMs);
        const headerDelay = parseRetryAfterMs(response, maxDelayMs);
        if (headerDelay !== null) {
            return Math.round(headerDelay);
        }

        const base = Math.max(200, Number(cfg.baseDelayMs) || DEFAULT_SETTINGS.baseDelayMs);
        const factor = Math.max(1, Number(cfg.backoffFactor) || DEFAULT_SETTINGS.backoffFactor);
        const jitterPct = Math.min(100, Math.max(0, Number(cfg.jitterPercent) || 0));

        const raw = Math.min(base * Math.pow(factor, attemptIndex), maxDelayMs);
        const jitterRatio = 1 + (Math.random() * 2 - 1) * (jitterPct / 100);
        return Math.max(300, Math.round(raw * jitterRatio));
    }

    function sleepWithAbort(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
                return;
            }
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);

            function onAbort() {
                clearTimeout(timer);
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            }

            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    function matchErrorText(text, cfg) {
        if (!text) return null;
        if (RATE_LIMIT_TEXT_PATTERN.test(text)) {
            return '429 (Resource Exhausted)';
        }
        if (cfg.retryOnOverload && OVERLOAD_TEXT_PATTERN.test(text)) {
            return '503 (服务临时过载)';
        }
        return null;
    }

    /**
     * 检查 SSE 事件文本是否为错误事件（只检查 error / API 错误，避免误判正常正文内容）
     */
    function inspectSseChunkForError(chunkText, cfg) {
        if (!chunkText) return null;

        // 逐行解析 SSE 的 data: 负载
        const lines = chunkText.split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(':')) continue;

            if (line.startsWith('event:') && /error/i.test(line)) {
                const reason = matchErrorText(chunkText, cfg);
                if (reason) return `SSE ${reason}`;
            }

            const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
            if (!payload || payload === '[DONE]') continue;

            try {
                const obj = JSON.parse(payload);
                // 仅当 JSON 显式包含 error 字段时才判定为 API 错误
                if (obj && obj.error) {
                    const errStr = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
                    const reason = matchErrorText(errStr, cfg);
                    if (reason) return `SSE ${reason}`;
                }
            } catch {
                // 非 JSON 行：仅在包含明显 API 错误前缀时判定
                if (/\[API\s*错误\]|endpoint failed with status/i.test(payload)) {
                    const reason = matchErrorText(payload, cfg);
                    if (reason) return `SSE ${reason}`;
                }
            }
        }
        return null;
    }

    /**
     * 对 2xx text/event-stream 响应无损窥视首个有效数据块：
     * - 若首个有效块就是 429/503 错误，直接取消流并告知需要重试；
     * - 若是正常流数据，重建一个新 Response 把已读出的块放回流首，零延迟透传后续所有数据。
     */
    async function peekEventStreamResponse(response, cfg) {
        if (!response.body) {
            return { retryReason: null, response };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const bufferedChunks = [];
        let accumulatedText = '';

        try {
            // 最多读 4 个非空 chunk（通常 1 个就够了，跳过前置心跳/空行）
            for (let i = 0; i < 4; i++) {
                const { done, value } = await reader.read();
                if (value && value.byteLength > 0) {
                    bufferedChunks.push(value);
                    accumulatedText += decoder.decode(value, { stream: !done });
                }

                const trimmed = accumulatedText.trim();
                const hasDataLine = /(?:^|\n)\s*(?:data:|event:|\{|\[API)/i.test(trimmed);

                if (hasDataLine || done) {
                    const sseError = inspectSseChunkForError(accumulatedText, cfg);
                    if (sseError) {
                        try {
                            await reader.cancel();
                        } catch {
                            // ignore
                        }
                        return { retryReason: sseError, response };
                    }
                    break;
                }
            }
        } catch (err) {
            // 如果读取首包时被用户中止，直接抛出 AbortError
            if (err && err.name === 'AbortError') {
                throw err;
            }
            logDebug('窥视 SSE 首包异常，直接放行:', err);
        }

        // 重建流：先把已缓存的 chunk 原样推出，再无缝透传剩余流
        const passthroughStream = new ReadableStream({
            start(controller) {
                for (const chunk of bufferedChunks) {
                    controller.enqueue(chunk);
                }
            },
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        controller.close();
                    } else if (value) {
                        controller.enqueue(value);
                    }
                } catch (err) {
                    controller.error(err);
                }
            },
            cancel(reason) {
                return reader.cancel(reason);
            },
        });

        const rebuiltResponse = new Response(passthroughStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });

        return { retryReason: null, response: rebuiltResponse };
    }

    async function inspectResponse(response, cfg) {
        const status = response.status;

        if (status === 429) {
            return { retryReason: 'HTTP 429 (Too Many Requests)', response };
        }

        if (cfg.retryOnOverload && (status === 502 || status === 503 || status === 529)) {
            return { retryReason: `HTTP ${status} (服务临时过载)`, response };
        }

        const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();

        // 流式 SSE 2xx：无损窥视首包，捕获 TauriTavern / 酒馆在 SSE 第一帧发回的 429 错误
        if (response.ok && contentType.includes('text/event-stream')) {
            return await peekEventStreamResponse(response, cfg);
        }

        // 非 2xx 响应，或 2xx 但返回 JSON/文本错误
        if (!response.ok || contentType.includes('application/json') || contentType.includes('text/plain')) {
            try {
                const text = await response.clone().text();
                if (!text) return { retryReason: null, response };

                if (response.ok) {
                    try {
                        const json = JSON.parse(text);
                        if (json && json.error) {
                            const errStr = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
                            const reason = matchErrorText(errStr, cfg);
                            if (reason) return { retryReason: `API ${reason}`, response };
                        }
                    } catch {
                        if (/\[API\s*错误\]|endpoint failed with status/i.test(text)) {
                            const reason = matchErrorText(text, cfg);
                            if (reason) return { retryReason: `API ${reason}`, response };
                        }
                    }
                    return { retryReason: null, response };
                }

                const reason = matchErrorText(text, cfg);
                if (reason) {
                    return { retryReason: `HTTP ${status} (${reason})`, response };
                }
            } catch {
                // 忽略解析异常
            }
        }

        return { retryReason: null, response };
    }

    function installFetchInterceptor() {
        const originalFetch = window.fetch.bind(window);

        window.fetch = async function patchedFetch(input, init) {
            const cfg = getSettings();
            if (!cfg.enabled || !isTargetRequest(input, init)) {
                return originalFetch(input, init);
            }

            if (cfg.onlyVertex && !isVertexRequest(init)) {
                return originalFetch(input, init);
            }

            const maxRetries = Math.min(20, Math.max(0, parseInt(cfg.maxRetries, 10) || 0));
            if (maxRetries <= 0) {
                return originalFetch(input, init);
            }

            const url = getRequestUrl(input);
            logDebug('拦截到生成请求:', url);

            const signal = init?.signal || (input instanceof Request ? input.signal : undefined);

            let lastResponse = null;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                if (signal?.aborted) {
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }

                const reqInput = input instanceof Request ? input.clone() : input;
                const rawResponse = await originalFetch(reqInput, init);
                const { retryReason, response } = await inspectResponse(rawResponse, cfg);
                lastResponse = response;

                if (!retryReason) {
                    if (attempt > 0) {
                        stats.recovered += 1;
                        updateStatsUI();
                        logDebug(`第 ${attempt} 次重试成功`);
                        notify('success', `第 ${attempt} 次重试成功，已恢复生成`);
                    }
                    return response;
                }

                if (attempt >= maxRetries) {
                    stats.failed += 1;
                    updateStatsUI();
                    logDebug(`已达最大重试次数 (${maxRetries})，放弃重试。原因: ${retryReason}`);
                    notify('error', `已重试 ${maxRetries} 次仍失败（${retryReason}）`);
                    return lastResponse;
                }

                stats.attempts += 1;
                updateStatsUI();

                const delayMs = computeDelayMs(attempt, response, cfg);
                const delaySec = (delayMs / 1000).toFixed(1);
                logDebug(`触发重试 (${attempt + 1}/${maxRetries})，原因: ${retryReason}，等待 ${delayMs}ms`);
                notify('warning', `${retryReason}，${delaySec}s 后进行第 ${attempt + 1}/${maxRetries} 次重试…`);

                await sleepWithAbort(delayMs, signal);
            }

            return lastResponse;
        };

        console.info('[429-Auto-Retry] v1.1.0 Fetch 拦截器已激活（支持流式 SSE 首包 429 检测）');
    }

    function renderSettingsUI() {
        if (document.getElementById('retry429_settings_root')) {
            return;
        }

        const container =
            document.getElementById('extensions_settings2') ||
            document.getElementById('extensions_settings');

        if (!container) {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.id = 'retry429_settings_root';
        wrapper.className = 'retry429-settings';
        wrapper.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>429 自动重试 (Vertex / API) v1.1</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="retry429-toggles">
                        <label class="checkbox_label" for="retry429_enabled">
                            <input id="retry429_enabled" type="checkbox" />
                            <span>启用 429 自动重试</span>
                        </label>
                        <label class="checkbox_label" for="retry429_overload">
                            <input id="retry429_overload" type="checkbox" />
                            <span>同时重试 502 / 503 / 529（服务临时过载）</span>
                        </label>
                        <label class="checkbox_label" for="retry429_only_vertex">
                            <input id="retry429_only_vertex" type="checkbox" />
                            <span>仅对 Vertex AI 渠道生效</span>
                        </label>
                        <label class="checkbox_label" for="retry429_toast">
                            <input id="retry429_toast" type="checkbox" />
                            <span>重试时显示气泡提示</span>
                        </label>
                        <label class="checkbox_label" for="retry429_debug">
                            <input id="retry429_debug" type="checkbox" />
                            <span>在控制台输出调试日志</span>
                        </label>
                    </div>

                    <div class="retry429-grid">
                        <div class="retry429-field">
                            <label for="retry429_max_retries">最大重试次数 (0-20)</label>
                            <input id="retry429_max_retries" class="text_pole" type="number" min="0" max="20" step="1" />
                        </div>
                        <div class="retry429-field">
                            <label for="retry429_base_delay">基础等待时间 (ms)</label>
                            <input id="retry429_base_delay" class="text_pole" type="number" min="200" max="60000" step="200" />
                        </div>
                        <div class="retry429-field">
                            <label for="retry429_backoff">指数退避倍率</label>
                            <input id="retry429_backoff" class="text_pole" type="number" min="1" max="5" step="0.5" />
                        </div>
                        <div class="retry429-field">
                            <label for="retry429_max_delay">单次等待上限 (ms)</label>
                            <input id="retry429_max_delay" class="text_pole" type="number" min="1000" max="120000" step="1000" />
                        </div>
                    </div>

                    <div class="retry429-hint">
                        策略：支持 HTTP 429 与流式 SSE 首包 429 检测；优先遵循 Retry-After，否则指数退避 + ±25% 抖动。点“停止生成”立即取消。
                    </div>

                    <div class="retry429-footer">
                        <span id="retry429_stats_text" class="retry429-stats"></span>
                        <button id="retry429_reset_btn" class="menu_button" type="button">恢复默认</button>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(wrapper);

        const syncToUI = () => {
            const current = getSettings();
            document.getElementById('retry429_enabled').checked = !!current.enabled;
            document.getElementById('retry429_overload').checked = !!current.retryOnOverload;
            document.getElementById('retry429_only_vertex').checked = !!current.onlyVertex;
            document.getElementById('retry429_toast').checked = !!current.showToast;
            document.getElementById('retry429_debug').checked = !!current.debugLog;
            document.getElementById('retry429_max_retries').value = current.maxRetries;
            document.getElementById('retry429_base_delay').value = current.baseDelayMs;
            document.getElementById('retry429_backoff').value = current.backoffFactor;
            document.getElementById('retry429_max_delay').value = current.maxDelayMs;
            updateStatsUI();
        };

        const bindCheckbox = (id, key) => {
            document.getElementById(id).addEventListener('change', (e) => {
                const current = getSettings();
                current[key] = !!e.target.checked;
                saveSettings();
            });
        };

        const bindNumber = (id, key, min, max, isFloat = false) => {
            document.getElementById(id).addEventListener('change', (e) => {
                const current = getSettings();
                let val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
                if (!Number.isFinite(val)) val = DEFAULT_SETTINGS[key];
                val = Math.min(max, Math.max(min, val));
                current[key] = val;
                e.target.value = val;
                saveSettings();
            });
        };

        bindCheckbox('retry429_enabled', 'enabled');
        bindCheckbox('retry429_overload', 'retryOnOverload');
        bindCheckbox('retry429_only_vertex', 'onlyVertex');
        bindCheckbox('retry429_toast', 'showToast');
        bindCheckbox('retry429_debug', 'debugLog');

        bindNumber('retry429_max_retries', 'maxRetries', 0, 20, false);
        bindNumber('retry429_base_delay', 'baseDelayMs', 200, 60000, false);
        bindNumber('retry429_backoff', 'backoffFactor', 1, 5, true);
        bindNumber('retry429_max_delay', 'maxDelayMs', 1000, 120000, false);

        document.getElementById('retry429_reset_btn').addEventListener('click', () => {
            const current = getSettings();
            Object.assign(current, DEFAULT_SETTINGS);
            saveSettings();
            syncToUI();
            notify('info', '已恢复默认重试配置');
        });

        syncToUI();
    }

    function mountUIWhenReady() {
        const tryRender = () => {
            if (document.getElementById('extensions_settings2') || document.getElementById('extensions_settings')) {
                renderSettingsUI();
                return true;
            }
            return false;
        };

        if (!tryRender()) {
            const timer = setInterval(() => {
                if (tryRender()) {
                    clearInterval(timer);
                }
            }, 500);
            setTimeout(() => clearInterval(timer), 15000);
        }
    }

    // 1. 立即同步挂载 fetch 拦截器，避免其他脚本提前缓存原始 window.fetch
    installFetchInterceptor();

    // 2. 等 DOM 就绪后挂载设置面板
    if (window.jQuery) {
        window.jQuery(mountUIWhenReady);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountUIWhenReady);
    } else {
        mountUIWhenReady();
    }
})();
