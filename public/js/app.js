/* ═══════════════════════════════════════════════════════════
   WhatsApp Automation Dashboard — Frontend Logic v2
   ═══════════════════════════════════════════════════════════ */

const API = '';

// ─── State ──────────────────────────────────────────────────
let currentSection = 'dashboard';
let CURRENT_USER = null;
let CURRENT_ACCESS_TOKEN = null;
let _refreshPromise = null;

async function refreshSession() {
    if (_refreshPromise) {
        return _refreshPromise;
    }
    _refreshPromise = (async () => {
        try {
            console.debug('[Auth] Initiating session refresh...');
            const res = await fetch('/api/auth/refresh', {
                method: 'POST',
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.accessToken) {
                    CURRENT_ACCESS_TOKEN = data.accessToken;
                    console.debug('[Auth] Session refreshed successfully.');
                    return { success: true };
                }
            }
            if (res.status === 401 || res.status === 403) {
                console.warn(`[Auth] Session invalid or expired on server (HTTP ${res.status}).`);
                return { success: false, isAuthFailure: true, status: res.status };
            }
            console.warn(`[Auth] Transient error during session refresh (HTTP ${res.status}). Session preserved.`);
            return { success: false, isAuthFailure: false, status: res.status };
        } catch (e) {
            console.warn('[Auth] Session refresh network error:', e.message);
            return { success: false, isAuthFailure: false, error: e.message };
        } finally {
            _refreshPromise = null;
        }
    })();
    return _refreshPromise;
}

function updateTopBarUserInfo(user) {
    if (!user) return;
    const nameEl   = document.getElementById('topbarUserName');
    const avatarEl = document.getElementById('topbarAvatar');
    const adminNav = document.getElementById('nav-admin');
    const label = user.business_name || user.owner_name || user.email || 'Account';
    if (nameEl)   nameEl.textContent = label;
    if (avatarEl) avatarEl.textContent = label.slice(0, 2).toUpperCase();
    if (adminNav) adminNav.style.display = user.role === 'admin' ? '' : 'none';
}

// ─── Auth gate ──────────────────────────────────────────────
// Every page under /app requires a logged-in session. If the session is
// definitively expired (401), we bounce to login. Temporary network errors
// or 5xx server issues never force a false logout.
async function checkAuth() {
    try {
        if (!CURRENT_ACCESS_TOKEN) {
            const refreshRes = await refreshSession();
            if (!refreshRes.success) {
                if (refreshRes.isAuthFailure) {
                    console.warn('[Auth] checkAuth failed with definitive auth failure. Redirecting to login.');
                    window.location.href = '/login';
                } else {
                    console.warn('[Auth] checkAuth encountered network/server issue. Retaining current page state.');
                }
                return false;
            }
        }
        let res;
        try {
            res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${CURRENT_ACCESS_TOKEN}` }
            });
        } catch (netErr) {
            console.warn('[Auth] Network error reaching /api/auth/me:', netErr.message);
            return false;
        }

        if (res.status === 401 || res.status === 403) {
            console.debug('[Auth] Access token expired on checkAuth. Refreshing...');
            const refreshRes = await refreshSession();
            if (refreshRes.success) {
                try {
                    res = await fetch('/api/auth/me', {
                        headers: { 'Authorization': `Bearer ${CURRENT_ACCESS_TOKEN}` }
                    });
                } catch (netErr) {
                    return false;
                }
            } else if (refreshRes.isAuthFailure) {
                console.warn('[Auth] Refresh rejected on checkAuth. Redirecting to login.');
                window.location.href = '/login';
                return false;
            } else {
                return false;
            }
        }

        if (!res.ok) {
            console.warn('[Auth] /api/auth/me returned status:', res.status);
            return false;
        }
        const json = await res.json();
        CURRENT_USER = json.data;
        updateTopBarUserInfo(CURRENT_USER);
        return true;
    } catch (err) {
        console.warn('[Auth] checkAuth error:', err.message);
        return false;
    }
}

async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    CURRENT_ACCESS_TOKEN = null;
    CURRENT_USER = null;
    window.location.href = '/login';
}

// ─── API Client ─────────────────────────────────────────────
async function api(endpoint, options = {}) {
    let headers = { 'Content-Type': 'application/json', ...options.headers };
    if (CURRENT_ACCESS_TOKEN) {
        headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
    }
    
    let res;
    try {
        res = await fetch(`${API}${endpoint}`, {
            ...options,
            headers
        });
    } catch (netErr) {
        console.warn(`[API] Network failure on ${endpoint}:`, netErr.message);
        throw new Error('Network connection error. Please verify your connection.');
    }
    
    if (res.status === 401) {
        console.debug(`[API] 401 received for ${endpoint}. Refreshing session...`);
        const refreshRes = await refreshSession();
        if (refreshRes.success) {
            headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
            try {
                res = await fetch(`${API}${endpoint}`, {
                    ...options,
                    headers
                });
            } catch (retryNetErr) {
                throw new Error('Network error during request retry.');
            }
        } else if (refreshRes.isAuthFailure) {
            console.warn(`[API] Session invalid on ${endpoint}. Redirecting to login.`);
            window.location.href = '/login';
            throw new Error('Session expired. Please log in again.');
        } else {
            console.warn(`[API] Transient failure refreshing session on ${endpoint}. Preserving session.`);
            throw new Error('Temporary server issue. Please try again in a moment.');
        }
    }

    if (res.status === 401) {
        console.warn(`[API] 401 persisted after refresh on ${endpoint}. Session rejected.`);
        window.location.href = '/login';
        throw new Error('Authentication required.');
    }

    let data;
    try {
        data = await res.json();
    } catch (jsonErr) {
        if (!res.ok) throw new Error(`Server error (${res.status})`);
        throw jsonErr;
    }
    if (!data.success) throw new Error(data.error || 'API request failed');
    return data.data;
}

// Proactive session refresh every 10 minutes so active sessions never expire
setInterval(async () => {
    if (CURRENT_ACCESS_TOKEN) {
        console.debug('[Auth] Performing scheduled proactive session refresh');
        await refreshSession();
    }
}, 10 * 60 * 1000);

// ─── Toast Notifications ────────────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const iconNames = { success: 'check-circle', error: 'x-circle', info: 'info' };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon" aria-hidden="true">${Icon(iconNames[type])}</span>
        <span class="toast-text">${escapeHtml(message)}</span>
        <button class="toast-close" aria-label="Dismiss notification" type="button">×</button>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.35s ease forwards';
        setTimeout(() => toast.remove(), 350);
    }, 4000);
}

// ─── Error Banner ────────────────────────────────────────────
function showErrorBanner(containerId, message, retryFn) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.style.display = 'flex';
    el.innerHTML = `
        <div class="error-banner" role="alert">
            <span aria-hidden="true">${Icon('triangle-alert')}</span>
            <span>${escapeHtml(message)}</span>
            ${retryFn ? `<button class="error-retry" type="button">Retry</button>` : ''}
        </div>
    `;
    if (retryFn) {
        el.querySelector('.error-retry').addEventListener('click', () => {
            clearErrorBanner(containerId);
            retryFn();
        });
    }
}

function clearErrorBanner(containerId) {
    const el = document.getElementById(containerId);
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

// ─── Skeleton Helpers ─────────────────────────────────────────
function showSkeleton(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
}

function hideSkeleton(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

// ─── Navigation ─────────────────────────────────────────────
function navigateTo(section) {
    // Guard against being called with nothing. Without this, `undefined`
    // matches every nav item that has no data-section (the Admin link) and
    // matches no section at all — which highlights Admin and blanks the
    // whole page instead of navigating anywhere.
    if (!section) return;

    currentSection = section;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        const active = !!item.dataset.section && item.dataset.section === section;
        item.classList.toggle('active', active);
        item.setAttribute('aria-current', active ? 'page' : 'false');
    });

    // Show section
    document.querySelectorAll('.section').forEach(sec => {
        sec.classList.toggle('active', sec.id === `section-${section}`);
    });

    // Close mobile sidebar
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    const menuToggle = document.getElementById('menuToggle');
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');

    // Load section data
    loadSectionData(section);
}

function loadSectionData(section) {
    switch (section) {
        case 'dashboard': loadDashboard(); break;
        case 'messages':  loadMessages();  break;
        case 'leads':     loadLeads(); break;
        case 'crm':       loadCrm(); break;
        case 'chatbot':   loadChatbotRules(); break;
        case 'contacts':  loadContacts(); break;
        case 'scheduled': loadScheduled(); break;
        case 'appointments': loadAppointments(); break;
        case 'settings':  loadSettings(); break;
    }
}

// ─── Settings Tab Switching ──────────────────────────────────
function initSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;

            // Update tab buttons
            tabs.forEach(t => {
                t.classList.toggle('active', t === tab);
                t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
            });

            // Update panels
            document.querySelectorAll('.settings-panel').forEach(panel => {
                panel.classList.toggle('active', panel.id === `stab-${target}`);
            });
        });
    });
}

// ═══════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════
async function loadDashboard() {
    clearErrorBanner('dashboardError');
    try {
        const stats = await api('/api/dashboard/stats');

        // Update demo mode indicator
        const indicator = document.getElementById('modeIndicator');
        if (indicator) {
            if (stats.demoMode) {
                indicator.innerHTML = `${Icon('flask-conical', 'icon-inline')}Demo Mode`;
                indicator.style.color = '#E3C15C';
            } else {
                indicator.innerHTML = `<span class="live-dot"></span>Live`;
                indicator.style.color = '#4ADE80';
            }
        }

        const setText = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        // ── Messages ──
        animateValue('valSentToday',        stats.sentToday);
        animateValue('valReceivedToday',    stats.receivedToday);
        animateValue('valTotalMessages',    stats.totalMessages);
        animateValue('valPendingScheduled', stats.pendingScheduled);

        // ── Leads ──
        const leads = stats.leads || {};
        animateValue('valDashLeadsTotal',   leads.total || 0);
        animateValue('valDashInterested',   leads.interested || 0);
        animateValue('valDashHighPriority', leads.highPriority || 0);
        animateValue('valDashAwaiting',     stats.awaitingAnalysis || 0);

        // ── Sales pipeline ──
        const crm = stats.crm || {};
        const cur = stats.currency || '₹';
        setText('valDashPipeline', `${cur}${(parseFloat(crm.pipelineValue) || 0).toLocaleString('en-IN')}`);
        animateValue('valDashOpenDeals', crm.openDeals || 0);
        animateValue('valDashWon',       crm.wonDeals || 0);
        animateValue('valDashFollowups', crm.followupsDue || 0);

        // ── Workspace ──
        animateValue('valContacts',    stats.totalContacts);
        animateValue('valActiveRules', stats.activeRules);

        const waEl = document.getElementById('valWaStatus');
        if (waEl) {
            waEl.textContent = stats.waConnected ? 'Connected' : 'Offline';
            waEl.style.color = stats.waConnected ? 'var(--color-success)' : 'var(--color-error)';
        }
        const aiEl = document.getElementById('valAiStatus');
        if (aiEl) {
            aiEl.textContent = stats.aiConfigured ? 'Active' : 'Setup needed';
            aiEl.style.color = stats.aiConfigured ? 'var(--color-success)' : 'var(--color-warning)';
        }
    } catch (err) {
        showErrorBanner('dashboardError', 'Failed to load dashboard data.', loadDashboard);
    }
}

function animateValue(elementId, target) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const safeTarget = Number.isFinite(target) ? target : (parseInt(target, 10) || 0);
    const start = parseInt(el.textContent, 10) || 0;
    const duration = 600;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(start + (safeTarget - start) * eased);
        if (progress < 1) requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// ═══════════════════════════════════════════════════════════
//  MESSAGES
// ═══════════════════════════════════════════════════════════
async function loadMessages() {
    clearErrorBanner('messagesError');
    try {
        const phone     = document.getElementById('messageSearch')?.value || '';
        const direction = document.getElementById('messageFilter')?.value || '';

        let endpoint = '/api/messages?limit=200';
        if (phone)     endpoint += `&phone=${encodeURIComponent(phone)}`;
        if (direction) endpoint += `&direction=${direction}`;

        const messages = await api(endpoint);
        const tbody = document.getElementById('messagesBody');

        if (messages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">${Icon('message-square')}</span>
                            <div class="empty-state-title">No messages found</div>
                            <p>Try adjusting your search or filter.</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td><span class="badge badge-${msg.direction}">${msg.direction === 'incoming' ? Icon('arrow-down-left') + ' In' : Icon('arrow-up-right') + ' Out'}</span></td>
                <td>
                    <strong>${escapeHtml(msg.contact_name || msg.phone)}</strong>
                    ${msg.contact_name ? `<br><small style="color:var(--color-text-secondary)">${escapeHtml(msg.phone)}</small>` : ''}
                </td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td><span class="badge badge-${msg.status}">${escapeHtml(msg.status)}</span></td>
                <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(msg.created_at)}</td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('messagesError', 'Failed to load messages.', loadMessages);
        document.getElementById('messagesBody').innerHTML =
            '<tr><td colspan="5" class="empty-state">Could not load messages.</td></tr>';
    }
}

// ═══════════════════════════════════════════════════════════
//  LEAD ANALYSIS
// ═══════════════════════════════════════════════════════════
const INTEREST_META = {
    interested:     { label: () => Icon('check-circle') + ' Interested',     cls: 'lead-badge-interested' },
    not_interested: { label: () => Icon('x-circle') + ' Not Interested',     cls: 'lead-badge-not-interested' },
    neutral:        { label: () => Icon('minus-circle') + ' Neutral',        cls: 'lead-badge-neutral' },
    unclear:        { label: () => Icon('help-circle') + ' Unclear',         cls: 'lead-badge-neutral' }
};

const PRIORITY_META = {
    high:   { label: () => Icon('flame') + ' High',           cls: 'lead-priority-high' },
    medium: { label: () => Icon('zap') + ' Medium',            cls: 'lead-priority-medium' },
    low:    { label: () => Icon('circle-dashed') + ' Low',     cls: 'lead-priority-low' }
};

async function loadLeads() {
    clearErrorBanner('leadsError');
    try {
        const interest = document.getElementById('leadInterestFilter')?.value || '';
        const priority = document.getElementById('leadPriorityFilter')?.value || '';

        let endpoint = '/api/leads';
        const params = [];
        if (interest) params.push(`interest=${encodeURIComponent(interest)}`);
        if (priority) params.push(`priority=${encodeURIComponent(priority)}`);
        if (params.length) endpoint += `?${params.join('&')}`;

        const { leads, stats, pending } = await api(endpoint);

        animateValue('valLeadsTotal',      stats.total);
        animateValue('valLeadsInterested', stats.interested);
        animateValue('valLeadsHigh',       stats.highPriority);
        animateValue('valLeadsPending',    pending.length);

        const container = document.getElementById('leadsList');

        let html = '';

        // Chats not yet analyzed (or with new messages)
        if (pending.length > 0 && !interest && !priority) {
            html += `
                <div class="card" style="margin-bottom:16px">
                    <h2 class="card-title">${Icon('hourglass', 'icon-inline')}Awaiting Analysis (${pending.length})</h2>
                    <div class="pending-leads">
                        ${pending.map(p => `
                            <div class="pending-lead-row">
                                <div>
                                    <strong>${escapeHtml(p.contact_name || p.phone)}</strong>
                                    <small style="color:var(--color-text-secondary);margin-left:8px">${escapeHtml(p.phone)} · ${p.message_count} msgs</small>
                                </div>
                                <button class="btn btn-sm btn-secondary" data-action="analyze-lead" data-phone="${escapeHtml(p.phone)}" type="button">${Icon('brain', 'icon-inline')}Analyze</button>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
        }

        if (leads.length === 0) {
            html += `
                <div class="empty-state">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('target')}</span>
                    <div class="empty-state-title">No lead analyses yet</div>
                    <p>${(interest || priority) ? 'No leads match these filters.' : 'Click "Analyze All Chats" to let the AI review your conversations.'}</p>
                </div>`;
        } else {
            html += leads.map(renderLeadCard).join('');
        }

        container.innerHTML = html;
    } catch (err) {
        showErrorBanner('leadsError', 'Failed to load lead analyses.', loadLeads);
        document.getElementById('leadsList').innerHTML = '';
    }
}

function renderLeadCard(lead) {
    const interest = INTEREST_META[lead.interest_status] || INTEREST_META.unclear;
    const priority = PRIORITY_META[lead.priority] || PRIORITY_META.low;

    let issues = [];
    try { issues = JSON.parse(lead.issues || '[]'); } catch (e) { issues = []; }

    return `
        <div class="card lead-card" data-phone="${escapeHtml(lead.phone)}">
            <div class="lead-card-header">
                <div class="lead-identity">
                    <strong>${escapeHtml(lead.contact_name || lead.phone)}</strong>
                    <small style="color:var(--color-text-secondary)">${escapeHtml(lead.phone)}</small>
                </div>
                <div class="lead-badges">
                    <span class="lead-badge ${interest.cls}">${interest.label()}</span>
                    <span class="lead-badge ${priority.cls}">${priority.label()}</span>
                    <span class="lead-badge lead-badge-score" title="Interest score">${lead.interest_score}/100</span>
                </div>
            </div>

            <div class="lead-summary">${escapeHtml(lead.summary)}</div>

            ${(lead.issue_category || issues.length) ? `
                <div class="lead-issues">
                    ${lead.issue_category ? `<span class="lead-badge lead-badge-category">${Icon('tag')} ${escapeHtml(lead.issue_category)}</span>` : ''}
                    ${issues.length ? `<ul>${issues.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}
                </div>` : ''}

            ${lead.next_action ? `
                <div class="lead-next-action">
                    <strong>${Icon('corner-down-right', 'icon-inline')}Next action:</strong> ${escapeHtml(lead.next_action)}
                </div>` : ''}

            <div class="lead-card-footer">
                <span style="color:var(--color-text-secondary);font-size:0.78rem">
                    ${escapeHtml(lead.priority_reason || '')}
                    · Sentiment: ${escapeHtml(lead.sentiment)}
                    · ${lead.message_count} msgs
                    · Analyzed ${timeAgo(lead.last_analyzed_at)}
                </span>
                <button class="btn btn-sm btn-secondary" data-action="analyze-lead" data-phone="${escapeHtml(lead.phone)}" type="button" title="Re-analyze with latest messages">${Icon('refresh-cw', 'icon-inline')}Re-analyze</button>
            </div>
        </div>`;
}

async function analyzeLead(phone) {
    showToast(`Analyzing conversation with ${phone}…`, 'info');
    try {
        await api(`/api/leads/analyze/${encodeURIComponent(phone)}`, { method: 'POST' });
        showToast('Analysis complete!', 'success');
        loadLeads();
    } catch (err) {
        showToast(err.message || 'Analysis failed', 'error');
    }
}

async function analyzeAllLeads() {
    const btn = document.getElementById('analyzeAllBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('hourglass')}</span> Analyzing… (this can take a while)`;

    try {
        const result = await api('/api/leads/analyze-all', { method: 'POST' });
        const failedNote = result.failed.length ? `, ${result.failed.length} failed` : '';
        showToast(`Analyzed ${result.analyzed} chat(s), ${result.skipped} already up to date${failedNote}.`,
                  result.failed.length ? 'error' : 'success');
        loadLeads();
    } catch (err) {
        showToast(err.message || 'Bulk analysis failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('brain')}</span> Analyze All Chats`;
    }
}

// ═══════════════════════════════════════════════════════════
//  CRM
// ═══════════════════════════════════════════════════════════
const STAGE_META = {
    new:         { text: 'New',          icon: 'circle-plus',    color: '#6B7280' },
    contacted:   { text: 'Contacted',    icon: 'phone',          color: '#3B82F6' },
    qualified:   { text: 'Qualified',    icon: 'star',           color: '#8B5CF6' },
    proposal:    { text: 'Proposal',     icon: 'file-text',      color: '#F59E0B' },
    negotiation: { text: 'Negotiation',  icon: 'handshake',      color: '#F97316' },
    won:         { text: 'Won',          icon: 'trophy',         color: '#22C55E' },
    lost:        { text: 'Lost',         icon: 'x-circle',       color: '#EF4444' }
};
// `label()` = icon + text (for headers/badges); plain `text` alone for <option> elements
Object.values(STAGE_META).forEach(s => { s.label = () => Icon(s.icon) + ' ' + s.text; });

let crmCurrency = '₹';
let crmDealsCache = [];

function fmtMoney(value) {
    const n = parseFloat(value) || 0;
    return `${crmCurrency}${n.toLocaleString('en-IN')}`;
}

// ─── CRM Analytics Charts ───────────────────────────────────
// Palette validated for colour-vision safety on the cream surface (#FFFDF6).
const CHART_INK = { text: '#23312A', sub: '#7B8378', grid: '#EFE8D8', surface: '#FFFDF6', tooltipBg: '#223129' };
const STAGE_RAMP = ['#79BF94', '#50AC76', '#2F8F58', '#1B7144', '#0D5231']; // ordinal: new → negotiation
const OPEN_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'negotiation'];
const INTEREST_ORDER = [
    { key: 'interested',     label: 'Interested',     color: '#1B9457' },
    { key: 'unclear',        label: 'Unclear',        color: '#C99B2E' },
    { key: 'not_interested', label: 'Not Interested', color: '#C4553D' },
    { key: 'neutral',        label: 'Neutral',        color: '#5E7FBF' }
];
const ACTIVITY_COLORS = { outgoing: '#1B9457', incoming: '#3E7CB1' };

let crmCharts = {};

function destroyCrmCharts() {
    Object.values(crmCharts).forEach(c => { try { c.destroy(); } catch (e) {} });
    crmCharts = {};
}

function chartTooltipStyle() {
    return {
        backgroundColor: CHART_INK.tooltipBg,
        titleColor: '#FBF8EE',
        bodyColor: '#FBF8EE',
        padding: 10,
        cornerRadius: 10,
        boxPadding: 4,
        displayColors: true
    };
}

function renderHtmlLegend(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const total = items.reduce((s, i) => s + i.value, 0) || 1;
    el.innerHTML = items.map(i => `
        <div class="chart-legend-row">
            <span class="chart-legend-swatch" style="background:${i.color}"></span>
            <span class="chart-legend-label">${escapeHtml(i.label)}</span>
            <span class="chart-legend-value">${i.formatted !== undefined ? i.formatted : i.value} · ${Math.round(i.value / total * 100)}%</span>
        </div>`).join('');
}

function renderCrmCharts(a) {
    const grid = document.getElementById('crmChartsGrid');
    if (!grid) return;
    if (typeof Chart === 'undefined') { grid.style.display = 'none'; return; } // CDN unavailable — charts skipped
    grid.style.display = '';
    destroyCrmCharts();

    Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
    Chart.defaults.font.size = 11.5;
    Chart.defaults.color = CHART_INK.sub;

    const byStage = {};
    (a.stageBreakdown || []).forEach(r => { byStage[r.stage] = r; });
    const stageLabels = ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation'];
    const stageCounts = OPEN_STAGES.map(s => byStage[s]?.count || 0);
    const stageValues = OPEN_STAGES.map(s => byStage[s]?.value || 0);
    const cur = a.currency || crmCurrency || '₹';

    // ── 1. Donut: open deals by stage (ordinal green ramp) ──
    const donutEl = document.getElementById('chartStageDeals');
    const legendDealsEl = document.getElementById('legendStageDeals');
    if (donutEl) {
        if (stageCounts.every(c => c === 0)) {
            donutEl.style.display = 'none';
            if (legendDealsEl) legendDealsEl.innerHTML = '<p class="chart-empty">No open deals yet — analyzed sales chats will appear here.</p>';
        } else {
            donutEl.style.display = '';
            crmCharts.stageDeals = new Chart(donutEl, {
                type: 'doughnut',
                data: {
                    labels: stageLabels,
                    datasets: [{
                        data: stageCounts,
                        backgroundColor: STAGE_RAMP,
                        borderColor: CHART_INK.surface,
                        borderWidth: 2,
                        hoverOffset: 6
                    }]
                },
                options: {
                    cutout: '62%',
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: chartTooltipStyle()
                    }
                }
            });
            renderHtmlLegend('legendStageDeals', stageLabels.map((l, i) => ({
                label: l, value: stageCounts[i], color: STAGE_RAMP[i]
            })).filter(i => i.value > 0));
        }
    }

    // ── 2. Bars: pipeline value by stage (same ordinal ramp) ──
    const barEl = document.getElementById('chartStageValue');
    if (barEl) {
        crmCharts.stageValue = new Chart(barEl, {
            type: 'bar',
            data: {
                labels: stageLabels,
                datasets: [{
                    data: stageValues,
                    backgroundColor: STAGE_RAMP,
                    borderRadius: { topLeft: 4, topRight: 4 },
                    maxBarThickness: 34
                }]
            },
            options: {
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        ...chartTooltipStyle(),
                        callbacks: { label: (ctx) => ` ${cur}${(ctx.parsed.y || 0).toLocaleString('en-IN')}` }
                    }
                },
                scales: {
                    x: { grid: { display: false }, border: { color: CHART_INK.grid } },
                    y: {
                        beginAtZero: true,
                        grid: { color: CHART_INK.grid },
                        border: { display: false },
                        ticks: { callback: (v) => cur + (v >= 1000 ? (v / 1000) + 'k' : v), maxTicksLimit: 6 }
                    }
                }
            }
        });
    }

    // ── 3. Donut: lead interest mix ──
    const intEl = document.getElementById('chartInterest');
    const legendIntEl = document.getElementById('legendInterest');
    if (intEl) {
        const mixMap = {};
        (a.interestMix || []).forEach(r => { mixMap[r.interest_status] = r.count; });
        const items = INTEREST_ORDER.map(i => ({ ...i, value: mixMap[i.key] || 0 }));
        if (items.every(i => i.value === 0)) {
            intEl.style.display = 'none';
            if (legendIntEl) legendIntEl.innerHTML = '<p class="chart-empty">No lead analyses yet — run "Analyze All Chats" in the Lead Analysis tab.</p>';
        } else {
            intEl.style.display = '';
            crmCharts.interest = new Chart(intEl, {
                type: 'doughnut',
                data: {
                    labels: items.map(i => i.label),
                    datasets: [{
                        data: items.map(i => i.value),
                        backgroundColor: items.map(i => i.color),
                        borderColor: CHART_INK.surface,
                        borderWidth: 2,
                        hoverOffset: 6
                    }]
                },
                options: {
                    cutout: '62%',
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: chartTooltipStyle() }
                }
            });
            renderHtmlLegend('legendInterest', items.filter(i => i.value > 0));
        }
    }

    // ── 4. Line: message activity, last 7 days ──
    const actEl = document.getElementById('chartActivity');
    if (actEl) {
        const days = a.messagesByDay || [];
        const labels = days.map(d => {
            const dt = new Date(d.day + 'T00:00:00');
            return isNaN(dt) ? d.day : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        });
        const lineCommon = {
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderColor: CHART_INK.surface,
            pointHoverBorderWidth: 2,
            tension: 0.35,
            fill: false
        };
        crmCharts.activity = new Chart(actEl, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Incoming', data: days.map(d => d.incoming), borderColor: ACTIVITY_COLORS.incoming, pointHoverBackgroundColor: ACTIVITY_COLORS.incoming, ...lineCommon },
                    { label: 'Outgoing', data: days.map(d => d.outgoing), borderColor: ACTIVITY_COLORS.outgoing, pointHoverBackgroundColor: ACTIVITY_COLORS.outgoing, ...lineCommon }
                ]
            },
            options: {
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'end',
                        labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, color: CHART_INK.text }
                    },
                    tooltip: chartTooltipStyle()
                },
                scales: {
                    x: { grid: { display: false }, border: { color: CHART_INK.grid } },
                    y: {
                        beginAtZero: true,
                        grid: { color: CHART_INK.grid },
                        border: { display: false },
                        ticks: { precision: 0, maxTicksLimit: 6 }
                    }
                }
            }
        });
    }
}

async function loadCrm() {
    clearErrorBanner('crmError');
    try {
        const [{ deals, stats, stages, currency }, analytics] = await Promise.all([
            api('/api/crm/deals'),
            api('/api/crm/analytics').catch(() => null)
        ]);
        crmCurrency = currency || '₹';
        crmDealsCache = deals;

        document.getElementById('valCrmPipeline').textContent = fmtMoney(stats.pipelineValue);
        animateValue('valCrmOpen', stats.openDeals);
        animateValue('valCrmWon',  stats.wonDeals);
        animateValue('valCrmFollowups', stats.followupsDue);

        if (analytics) renderCrmCharts(analytics);
        else document.getElementById('crmChartsGrid')?.style.setProperty('display', 'none');

        const board = document.getElementById('kanbanBoard');

        if (deals.length === 0) {
            board.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('trending-up')}</span>
                    <div class="empty-state-title">No deals yet</div>
                    <p>Run a lead analysis (Lead Analysis tab) or add a deal manually — sales chats become deals automatically.</p>
                </div>`;
            return;
        }

        board.innerHTML = stages.map(stage => {
            const meta = STAGE_META[stage];
            const stageDeals = deals.filter(d => d.stage === stage);
            const stageValue = stageDeals.reduce((sum, d) => sum + (parseFloat(d.deal_value) || 0), 0);
            return `
                <div class="kanban-column" data-stage="${stage}">
                    <div class="kanban-column-header" style="border-top: 3px solid ${meta.color}">
                        <span class="kanban-column-title">${meta.label()}</span>
                        <span class="kanban-column-meta">${stageDeals.length}${stageValue ? ` · ${fmtMoney(stageValue)}` : ''}</span>
                    </div>
                    <div class="kanban-cards">
                        ${stageDeals.map(renderDealCard).join('') || '<div class="kanban-empty">—</div>'}
                    </div>
                </div>`;
        }).join('');
    } catch (err) {
        showErrorBanner('crmError', 'Failed to load CRM pipeline.', loadCrm);
        document.getElementById('kanbanBoard').innerHTML = '';
    }
}

function renderDealCard(deal) {
    const followupDue = deal.next_followup_at && new Date(deal.next_followup_at + 'Z') <= new Date()
        && !['won', 'lost'].includes(deal.stage);
    const priorityBadge = deal.priority
        ? `<span class="lead-badge ${(PRIORITY_META[deal.priority] || PRIORITY_META.low).cls}">${(PRIORITY_META[deal.priority] || PRIORITY_META.low).label()}</span>`
        : '';

    return `
        <div class="deal-card" data-action="open-deal" data-phone="${escapeHtml(deal.phone)}" role="button" tabindex="0">
            <div class="deal-card-top">
                <strong>${escapeHtml(deal.contact_name || deal.phone)}</strong>
                ${deal.deal_value ? `<span class="deal-value">${fmtMoney(deal.deal_value)}</span>` : ''}
            </div>
            ${deal.product_interest ? `<div class="deal-product">${Icon('package', 'icon-inline')}${escapeHtml(deal.product_interest)}</div>` : ''}
            <div class="deal-card-badges">
                ${priorityBadge}
                ${deal.interest_score ? `<span class="lead-badge lead-badge-score">${deal.interest_score}/100</span>` : ''}
                ${followupDue ? `<span class="lead-badge lead-priority-high">${Icon('clock')} Follow up!</span>` : ''}
            </div>
        </div>`;
}

// ─── Deal detail modal ──────────────────────────────────────
let currentDealPhone = null;

async function openDealModal(phone) {
    currentDealPhone = phone;
    const backdrop = document.getElementById('dealModalBackdrop');
    const body = document.getElementById('dealModalBody');
    const title = document.getElementById('dealModalTitle');

    backdrop.style.display = 'flex';
    body.innerHTML = '<div class="empty-state">Loading deal…</div>';

    try {
        const { deal, analysis, activities } = await api(`/api/crm/deals/phone/${encodeURIComponent(phone)}`);
        title.textContent = deal.contact_name || deal.phone;

        const followupVal = deal.next_followup_at ? deal.next_followup_at.replace(' ', 'T').slice(0, 16) : '';

        body.innerHTML = `
            <div class="deal-detail-grid">
                <div class="form-group">
                    <label>Stage</label>
                    <select id="modalDealStage">
                        ${Object.keys(STAGE_META).map(s =>
                            `<option value="${s}" ${deal.stage === s ? 'selected' : ''}>${STAGE_META[s].text}</option>`).join('')}
                    </select>
                    ${deal.ai_suggested_stage && deal.ai_suggested_stage !== deal.stage
                        ? `<p class="form-text">${Icon('brain', 'icon-inline')}AI suggests: <strong>${escapeHtml(deal.ai_suggested_stage)}</strong></p>` : ''}
                </div>
                <div class="form-group">
                    <label>Deal Value (${escapeHtml(crmCurrency)})</label>
                    <input type="number" id="modalDealValue" value="${parseFloat(deal.deal_value) || 0}" min="0" step="any">
                    ${deal.ai_estimated_value && !parseFloat(deal.deal_value)
                        ? `<p class="form-text">${Icon('brain', 'icon-inline')}AI estimate: ${fmtMoney(deal.ai_estimated_value)}</p>` : ''}
                </div>
                <div class="form-group">
                    <label>Product / Service</label>
                    <input type="text" id="modalDealProduct" value="${escapeHtml(deal.product_interest || '')}">
                </div>
                <div class="form-group">
                    <label>Next Follow-up</label>
                    <input type="datetime-local" id="modalDealFollowup" value="${followupVal}">
                </div>
            </div>

            <div class="form-group">
                <label>Deal Notes</label>
                <textarea id="modalDealNotes" rows="2">${escapeHtml(deal.notes || '')}</textarea>
            </div>

            <div class="modal-actions">
                <button class="btn btn-primary btn-sm" data-action="save-deal" data-id="${deal.id}" type="button">${Icon('save', 'icon-inline')}Save Changes</button>
                <button class="btn btn-danger btn-sm" data-action="delete-deal" data-id="${deal.id}" type="button">${Icon('trash-2', 'icon-inline')}Delete Deal</button>
                <small style="color:var(--color-text-secondary)">${escapeHtml(deal.phone)} · Source: ${escapeHtml(deal.source || 'whatsapp')}</small>
            </div>

            ${analysis ? `
                <div class="modal-section">
                    <h3>${Icon('target', 'icon-inline')}AI Conversation Insight</h3>
                    <div class="lead-summary">${escapeHtml(analysis.summary || '')}</div>
                    ${analysis.next_action ? `<div class="lead-next-action"><strong>${Icon('corner-down-right', 'icon-inline')}Next action:</strong> ${escapeHtml(analysis.next_action)}</div>` : ''}
                </div>` : `
                <div class="modal-section">
                    <h3>${Icon('target', 'icon-inline')}AI Conversation Insight</h3>
                    <p style="color:var(--color-text-secondary);font-size:0.85rem">Not analyzed yet — run it from the Lead Analysis tab.</p>
                </div>`}

            <div class="modal-section">
                <h3>${Icon('sticky-note', 'icon-inline')}Activity & Notes</h3>
                <div class="note-form">
                    <input type="text" id="modalNewNote" placeholder="Add a note… (e.g. called them, sent quote)">
                    <button class="btn btn-secondary btn-sm" data-action="add-note" type="button">Add</button>
                </div>
                <div class="activity-timeline" id="modalActivities">
                    ${activities.length ? activities.map(renderActivity).join('') : '<p style="color:var(--color-text-secondary);font-size:0.85rem">No activity yet.</p>'}
                </div>
            </div>`;
    } catch (err) {
        body.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load deal</div><p>${escapeHtml(err.message)}</p></div>`;
    }
}

function renderActivity(act) {
    const icons = { note: 'sticky-note', ai: 'brain', stage: 'shuffle', system: 'settings' };
    return `
        <div class="activity-entry">
            <span class="activity-entry-icon">${Icon(icons[act.type] || 'sticky-note')}</span>
            <div class="activity-entry-body">
                <div>${escapeHtml(act.content)}</div>
                <small>${formatDate(act.created_at)}</small>
            </div>
        </div>`;
}

function closeDealModal() {
    document.getElementById('dealModalBackdrop').style.display = 'none';
    currentDealPhone = null;
}

async function saveDealFromModal(dealId) {
    try {
        await api(`/api/crm/deals/${dealId}`, {
            method: 'PUT',
            body: JSON.stringify({
                stage:            document.getElementById('modalDealStage').value,
                deal_value:       document.getElementById('modalDealValue').value,
                product_interest: document.getElementById('modalDealProduct').value,
                next_followup_at: document.getElementById('modalDealFollowup').value
                                    ? document.getElementById('modalDealFollowup').value.replace('T', ' ') : null,
                notes:            document.getElementById('modalDealNotes').value
            })
        });
        showToast('Deal updated', 'success');
        closeDealModal();
        loadCrm();
    } catch (err) {
        showToast(err.message || 'Failed to update deal', 'error');
    }
}

async function deleteDealFromModal(dealId) {
    if (!confirm('Delete this deal? The conversation and lead analysis are kept.')) return;
    try {
        await api(`/api/crm/deals/${dealId}`, { method: 'DELETE' });
        showToast('Deal deleted', 'success');
        closeDealModal();
        loadCrm();
    } catch (err) {
        showToast('Failed to delete deal', 'error');
    }
}

async function addNoteFromModal() {
    const input = document.getElementById('modalNewNote');
    const content = input.value.trim();
    if (!content || !currentDealPhone) return;
    try {
        await api(`/api/crm/deals/phone/${encodeURIComponent(currentDealPhone)}/notes`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        input.value = '';
        // Refresh just the modal content
        openDealModal(currentDealPhone);
    } catch (err) {
        showToast('Failed to add note', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  BUSINESS SETUP
// ═══════════════════════════════════════════════════════════
async function loadBusiness() {
    try {
        const biz = await api('/api/business');

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val || '';
        };
        set('bizWebsite',     biz.website);
        set('bizIndustry',    biz.industry);
        set('bizDescription', biz.description);
        set('bizTarget',      biz.targetCustomers);
        set('bizCurrency',    biz.currency);
        set('bizOffers',      biz.offers);

        renderProductList(biz.products || []);
        if (biz.aiProfile) renderBusinessProfile(biz.aiProfile);
    } catch (err) {
        showToast('Failed to load business info', 'error');
    }
}

function renderProductList(products) {
    const container = document.getElementById('productList');
    if (!container) return;

    if (products.length === 0) {
        container.innerHTML = '<p style="color:var(--color-text-secondary);font-size:0.85rem">No products yet — add your catalog above so the AI can quote it to customers.</p>';
        return;
    }

    container.innerHTML = products.map(p => {
        const thumbHtml = p.image_path
            ? `<div class="product-thumb-box" data-action="preview-product-image" data-src="/api/products/images/${encodeURIComponent(p.image_path)}" data-title="${escapeHtml(p.name)}" title="Click to enlarge image" role="button" tabindex="0">
                 <img src="/api/products/images/${encodeURIComponent(p.image_path)}"
                      alt="${escapeHtml(p.name)}"
                      class="product-thumb-img"
                      loading="lazy" />
               </div>`
            : `<div class="product-thumb-box" title="No image"><div class="product-thumb-placeholder">${Icon('package')}</div></div>`;

        return `
            <div class="product-row ${p.is_active ? '' : 'disabled'}" id="product-row-${p.id}" data-id="${p.id}">
                <div class="product-row-main">
                    ${thumbHtml}
                    <div class="product-row-info">
                        <div class="product-row-title-bar">
                            <span class="product-row-name">${escapeHtml(p.name)}</span>
                            ${p.price ? `<span class="lead-badge lead-badge-score">${escapeHtml(p.price)}</span>` : ''}
                            ${p.category ? `<span class="lead-badge lead-badge-category">${escapeHtml(p.category)}</span>` : ''}
                            ${!p.is_active ? `<span class="lead-badge lead-badge-neutral" style="opacity:0.85">${Icon('eye-off', 'icon-inline')}Hidden from AI</span>` : ''}
                        </div>
                        ${p.description ? `<div class="product-row-desc">${escapeHtml(p.description)}</div>` : ''}
                        ${p.url ? `<div class="product-row-desc"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a></div>` : ''}
                    </div>
                </div>
                <div class="rule-actions">
                    <button class="btn btn-sm btn-secondary" data-action="edit-product" data-id="${p.id}" title="Edit Product / Image" type="button">${Icon('pencil')}</button>
                    <button class="btn btn-sm btn-secondary" data-action="toggle-product" data-id="${p.id}" data-active="${p.is_active ? 0 : 1}" title="${p.is_active ? 'Hide from AI' : 'Show to AI'}" type="button">${Icon(p.is_active ? 'pause' : 'play')}</button>
                    <button class="btn btn-sm btn-danger" data-action="delete-product" data-id="${p.id}" title="Delete" type="button">${Icon('trash-2')}</button>
                </div>
            </div>
        `;
    }).join('');
}

async function uploadProductImageFile(file) {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        throw new Error('Unsupported format. Please upload JPEG, PNG, or WebP images.');
    }
    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
        throw new Error('File exceeds the 5 MB maximum size limit.');
    }

    const formData = new FormData();
    formData.append('image', file);

    const headers = {};
    if (CURRENT_ACCESS_TOKEN) {
        headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
    }

    let res = await fetch(`${API}/api/products/upload-image`, {
        method: 'POST',
        headers,
        body: formData
    });

    if (res.status === 401) {
        const refreshRes = await refreshSession();
        if (refreshRes.success) {
            headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
            res = await fetch(`${API}/api/products/upload-image`, {
                method: 'POST',
                headers,
                body: formData
            });
        } else if (refreshRes.isAuthFailure) {
            window.location.href = '/login';
            throw new Error('Not authenticated');
        } else {
            throw new Error('Temporary server issue during upload. Please try again.');
        }
    }

    const data = await res.json();
    if (!data.success) {
        throw new Error(data.error || 'Failed to upload product image');
    }
    return data.data;
}

function setupProductImageUploader(prefix) {
    const fileInput = document.getElementById(`${prefix}ImageFile`);
    const hiddenInput = document.getElementById(`${prefix}ImagePath`);
    const dropzone = document.getElementById(`${prefix}Dropzone`);
    const previewContainer = document.getElementById(`${prefix}PreviewContainer`);
    const previewImg = document.getElementById(`${prefix}ImagePreview`);
    const filenameEl = document.getElementById(`${prefix}ImageFilename`);
    const statusEl = document.getElementById(`${prefix}ImageStatus`);
    const removeBtn = document.getElementById(`${prefix}ImageRemoveBtn`);

    if (!fileInput || !dropzone) return;

    dropzone.addEventListener('click', (e) => {
        e.preventDefault();
        fileInput.click();
    });

    const changeBtn = document.getElementById(`${prefix}ImageChangeBtn`) ||
                      document.getElementById(`${prefix}ImageReplaceBtn`) ||
                      previewContainer?.querySelector('.btn-secondary');
    changeBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        fileInput.click();
    });

    ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        });
    });
    ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        });
    });

    dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            handleFileSelect(files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        const files = e.target.files;
        if (files && files.length > 0) {
            handleFileSelect(files[0]);
        }
    });

    async function handleFileSelect(file) {
        const objectUrl = URL.createObjectURL(file);
        previewImg.src = objectUrl;
        filenameEl.textContent = file.name;
        statusEl.className = 'preview-status';
        statusEl.textContent = 'Uploading…';
        dropzone.style.display = 'none';
        previewContainer.style.display = 'flex';

        try {
            const uploaded = await uploadProductImageFile(file);
            hiddenInput.value = uploaded.filename;
            statusEl.className = 'preview-status';
            statusEl.textContent = 'Ready to save';
            showToast('Image uploaded successfully', 'success');
        } catch (err) {
            statusEl.className = 'preview-status error';
            statusEl.textContent = err.message || 'Upload failed';
            hiddenInput.value = '';
            showToast(err.message || 'Image upload failed', 'error');
        }
    }

    removeBtn?.addEventListener('click', () => {
        resetProductImageUploader(prefix);
    });
}

function resetProductImageUploader(prefix) {
    const fileInput = document.getElementById(`${prefix}ImageFile`);
    const hiddenInput = document.getElementById(`${prefix}ImagePath`);
    const dropzone = document.getElementById(`${prefix}Dropzone`);
    const previewContainer = document.getElementById(`${prefix}PreviewContainer`);
    const previewImg = document.getElementById(`${prefix}ImagePreview`);
    const filenameEl = document.getElementById(`${prefix}ImageFilename`);
    const statusEl = document.getElementById(`${prefix}ImageStatus`);

    if (fileInput) fileInput.value = '';
    if (hiddenInput) hiddenInput.value = '';
    if (previewImg) previewImg.src = '';
    if (filenameEl) filenameEl.textContent = '';
    if (statusEl) {
        statusEl.className = 'preview-status';
        statusEl.textContent = '';
    }
    if (dropzone) dropzone.style.display = 'flex';
    if (previewContainer) previewContainer.style.display = 'none';
}

async function openEditProductModal(id) {
    try {
        const p = await api(`/api/products/${id}`);
        if (!p) throw new Error('Product not found');

        document.getElementById('editProdId').value = p.id;
        document.getElementById('editProdName').value = p.name || '';
        document.getElementById('editProdPrice').value = p.price || '';
        document.getElementById('editProdCategory').value = p.category || '';
        document.getElementById('editProdDesc').value = p.description || '';
        document.getElementById('editProdUrl').value = p.url || '';
        document.getElementById('editProdImagePath').value = p.image_path || '';

        const dropzone = document.getElementById('editProdDropzone');
        const previewContainer = document.getElementById('editProdPreviewContainer');
        const previewImg = document.getElementById('editProdImagePreview');
        const filenameEl = document.getElementById('editProdImageFilename');
        const statusEl = document.getElementById('editProdImageStatus');

        if (p.image_path) {
            previewImg.src = `/api/products/images/${encodeURIComponent(p.image_path)}`;
            filenameEl.textContent = p.image_path;
            statusEl.className = 'preview-status';
            statusEl.textContent = 'Current image';
            dropzone.style.display = 'none';
            previewContainer.style.display = 'flex';
        } else {
            resetProductImageUploader('editProd');
        }

        document.getElementById('editProductModalBackdrop').style.display = 'flex';
    } catch (err) {
        showToast('Failed to open product: ' + err.message, 'error');
    }
}

function closeEditProductModal() {
    const backdrop = document.getElementById('editProductModalBackdrop');
    if (backdrop) backdrop.style.display = 'none';
    resetProductImageUploader('editProd');
}

function previewProductImage(src, title) {
    const backdrop = document.getElementById('imageLightboxBackdrop');
    const img = document.getElementById('imageLightboxImg');
    const titleEl = document.getElementById('imageLightboxTitle');
    if (backdrop && img) {
        img.src = src;
        if (titleEl) titleEl.textContent = title || 'Product Image';
        backdrop.style.display = 'flex';
    }
}

function closeImageLightbox() {
    const backdrop = document.getElementById('imageLightboxBackdrop');
    if (backdrop) backdrop.style.display = 'none';
}

async function toggleProduct(id, newState) {
    const row = document.getElementById(`product-row-${id}`);
    const btn = row?.querySelector('[data-action="toggle-product"]');
    if (btn) btn.disabled = true;

    try {
        await api(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: newState }) });
        showToast(newState ? 'Product is now visible to AI' : 'Product hidden from AI', 'success');
        await loadBusiness();
    } catch (err) {
        showToast(err.message || 'Failed to update product', 'error');
        if (btn) btn.disabled = false;
    }
}

async function deleteProductRow(id) {
    if (!confirm('Remove this product from the catalog? This will delete the item and its image.')) return;
    const row = document.getElementById(`product-row-${id}`);
    const btn = row?.querySelector('[data-action="delete-product"]');
    if (btn) btn.disabled = true;

    try {
        await api(`/api/products/${id}`, { method: 'DELETE' });
        showToast('Product removed from catalog', 'success');
        if (row) row.remove();
        await loadBusiness();
    } catch (err) {
        showToast(err.message || 'Failed to remove product', 'error');
        if (btn) btn.disabled = false;
    }
}
window.deleteProductRow = deleteProductRow;

function renderBusinessProfile(profile) {
    const container = document.getElementById('businessProfileResult');
    if (!container) return;

    const list = (arr) => (arr || []).map(i => `<li>${escapeHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('');

    container.innerHTML = `
        <div class="biz-profile">
            <div class="biz-profile-block">
                <h4>${Icon('map-pin', 'icon-inline')}Positioning</h4>
                <p>${escapeHtml(profile.profile_summary || '')}</p>
            </div>
            ${profile.selling_points?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('sparkles', 'icon-inline')}Selling Points</h4>
                    <ul>${list(profile.selling_points)}</ul>
                </div>` : ''}
            ${profile.ideal_customer ? `
                <div class="biz-profile-block">
                    <h4>${Icon('target', 'icon-inline')}Ideal Customer</h4>
                    <p>${escapeHtml(profile.ideal_customer)}</p>
                </div>` : ''}
            ${profile.sales_pitch ? `
                <div class="biz-profile-block">
                    <h4>${Icon('message-circle', 'icon-inline')}Ready-to-send Pitch</h4>
                    <p class="biz-pitch">${escapeHtml(profile.sales_pitch)}</p>
                </div>` : ''}
            ${profile.objection_handling?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('shield', 'icon-inline')}Objection Handling</h4>
                    <ul>${profile.objection_handling.map(o => `<li><strong>${escapeHtml(o.objection || '')}</strong> — ${escapeHtml(o.response || '')}</li>`).join('')}</ul>
                </div>` : ''}
            ${profile.faq?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('help-circle', 'icon-inline')}Suggested FAQ</h4>
                    <ul>${profile.faq.map(f => `<li><strong>${escapeHtml(f.q || '')}</strong> — ${escapeHtml(f.a || '')}</li>`).join('')}</ul>
                </div>` : ''}
            ${profile.improvement_tips?.length ? `
                <div class="biz-profile-block">
                    <h4>${Icon('trending-up', 'icon-inline')}Tips to Convert More</h4>
                    <ul>${list(profile.improvement_tips)}</ul>
                </div>` : ''}
            ${profile.analyzed_at ? `<small style="color:var(--color-text-secondary)">Analyzed ${timeAgo(profile.analyzed_at)}</small>` : ''}
        </div>`;
}

async function analyzeBusiness() {
    const btn = document.getElementById('analyzeBusinessBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('hourglass')}</span> Analyzing your business…`;
    try {
        const profile = await api('/api/business/analyze', { method: 'POST' });
        renderBusinessProfile(profile);
        showToast('Business analysis complete! The AI will now use this in replies and lead scoring.', 'success');
    } catch (err) {
        showToast(err.message || 'Business analysis failed', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('brain')}</span> Analyze My Business`;
    }
}

// ═══════════════════════════════════════════════════════════
//  CHATBOT RULES
// ═══════════════════════════════════════════════════════════
async function loadChatbotRules() {
    clearErrorBanner('chatbotError');
    showSkeleton('rulesSkeleton');
    try {
        const rules = await api('/api/chatbot/rules');
        hideSkeleton('rulesSkeleton');
        const container = document.getElementById('rulesList');

        if (rules.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-icon" aria-hidden="true">${Icon('bot')}</span>
                    <div class="empty-state-title">No chatbot rules yet</div>
                    <p>Add your first rule above to get started!</p>
                </div>`;
            return;
        }

        container.innerHTML = rules.map(rule => `
            <div class="rule-item ${rule.is_active ? '' : 'disabled'}" data-id="${rule.id}">
                <div class="rule-info">
                    <div class="rule-trigger">
                        <span class="rule-keyword">"${escapeHtml(rule.trigger_keyword)}"</span>
                        <span class="rule-match-type">${escapeHtml(rule.match_type)}</span>
                        ${!rule.is_active ? '<span class="badge badge-cancelled">Disabled</span>' : ''}
                    </div>
                    <div class="rule-response">${escapeHtml(rule.response_text)}</div>
                    <div class="rule-meta">
                        <span>Priority: ${rule.priority}</span>
                        <span aria-hidden="true">•</span>
                        <span>Hits: ${rule.hit_count}</span>
                    </div>
                </div>
                <div class="rule-actions">
                    <button
                        class="btn btn-sm btn-secondary"
                        data-action="toggle-rule"
                        data-id="${rule.id}"
                        data-active="${rule.is_active ? 0 : 1}"
                        title="${rule.is_active ? 'Disable rule' : 'Enable rule'}"
                        aria-label="${rule.is_active ? 'Disable' : 'Enable'} rule: ${escapeHtml(rule.trigger_keyword)}"
                        type="button">
                        ${Icon(rule.is_active ? 'pause' : 'play')}
                    </button>
                    <button
                        class="btn btn-sm btn-danger"
                        data-action="delete-rule"
                        data-id="${rule.id}"
                        title="Delete rule"
                        aria-label="Delete rule: ${escapeHtml(rule.trigger_keyword)}"
                        type="button">
                        ${Icon('trash-2')}
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        hideSkeleton('rulesSkeleton');
        showErrorBanner('chatbotError', 'Failed to load chatbot rules.', loadChatbotRules);
        document.getElementById('rulesList').innerHTML = '';
    }
}

async function toggleRule(id, newState) {
    try {
        await api(`/api/chatbot/rules/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: newState })
        });
        showToast(`Rule ${newState ? 'enabled' : 'disabled'}`, 'success');
        loadChatbotRules();
    } catch (err) {
        showToast('Failed to update rule', 'error');
    }
}

async function deleteRule(id) {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    try {
        await api(`/api/chatbot/rules/${id}`, { method: 'DELETE' });
        showToast('Rule deleted', 'success');
        loadChatbotRules();
    } catch (err) {
        showToast('Failed to delete rule', 'error');
    }
}

async function testChatbot() {
    const input    = document.getElementById('testMessage');
    const resultEl = document.getElementById('testResult');
    const text     = input.value.trim();

    if (!text) { input.focus(); return; }

    const btn = document.getElementById('testChatbotBtn');
    btn.disabled = true;
    btn.textContent = 'Testing…';

    try {
        const result = await api('/api/chatbot/test', {
            method: 'POST',
            body: JSON.stringify({ message: text })
        });

        resultEl.style.display = 'block';

        if (result.matched) {
            resultEl.className = 'test-result matched';
            resultEl.innerHTML = `
                <strong>${Icon('check-circle', 'icon-inline')}Rule #${result.ruleId} matched!</strong><br>
                <strong>Keyword:</strong> "${escapeHtml(result.keyword)}" (${escapeHtml(result.matchType)})<br>
                <strong>Response:</strong> ${escapeHtml(result.response)}
            `;
        } else {
            resultEl.className = 'test-result no-match';
            resultEl.innerHTML = result.willSendDefault
                ? `<strong>${Icon('triangle-alert', 'icon-inline')}No rule matched.</strong> Default reply will be sent:<br>"${escapeHtml(result.defaultReply)}"`
                : `<strong>${Icon('triangle-alert', 'icon-inline')}No rule matched</strong> and no default reply configured.`;
        }
    } catch (err) {
        showToast('Test failed', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Test';
    }
}

// ═══════════════════════════════════════════════════════════
//  CONTACTS
// ═══════════════════════════════════════════════════════════
// Contacts currently checked for bulk outreach — cleared on every reload
// (a checked contact that scrolls out of a new search/filter shouldn't
// silently stay "selected" for a send the user can no longer see).
let SELECTED_CONTACTS = new Map(); // id -> { id, phone, name }
let LAST_LOADED_CONTACTS = [];

async function loadContacts() {
    clearErrorBanner('contactsError');
    try {
        const search   = document.getElementById('contactSearch')?.value || '';
        let endpoint   = '/api/contacts';
        if (search) endpoint += `?search=${encodeURIComponent(search)}`;

        const contacts = await api(endpoint);
        LAST_LOADED_CONTACTS = contacts;
        SELECTED_CONTACTS.clear();
        updateSelectionBar();
        const tbody    = document.getElementById('contactsBody');
        const selectAll = document.getElementById('contactsSelectAll');
        if (selectAll) selectAll.checked = false;

        if (contacts.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">${Icon('users')}</span>
                            <div class="empty-state-title">No contacts found</div>
                            <p>${search ? 'Try a different search term.' : 'Add your first contact above, or import a CSV!'}</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = contacts.map(c => `
            <tr>
                <td><input type="checkbox" class="contact-row-check" data-id="${c.id}" data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml(c.name || '')}" data-reached="${c.last_outreach_at ? '1' : '0'}" aria-label="Select ${escapeHtml(c.name || c.phone)}"></td>
                <td><strong>${escapeHtml(c.name) || '—'}</strong></td>
                <td style="color:var(--color-text-secondary)">${escapeHtml(c.phone)}</td>
                <td>${c.label ? `<span class="badge badge-incoming">${escapeHtml(c.label)}</span>` : '—'}</td>
                <td>${c.last_outreach_at
                    ? `<span class="reached-pill" title="${formatDate(c.last_outreach_at)}">${Icon('check-circle')} ${formatDate(c.last_outreach_at)}</span>`
                    : `<span class="not-reached-label">Not yet</span>`}</td>
                <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(c.created_at)}</td>
                <td>
                    <button
                        class="btn btn-sm btn-danger"
                        data-action="delete-contact"
                        data-id="${c.id}"
                        title="Delete contact"
                        aria-label="Delete contact ${escapeHtml(c.name || c.phone)}"
                        type="button">${Icon('trash-2')}</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.contact-row-check').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = Number(cb.dataset.id);
                if (cb.checked) SELECTED_CONTACTS.set(id, { id, phone: cb.dataset.phone, name: cb.dataset.name, reached: cb.dataset.reached === '1' });
                else SELECTED_CONTACTS.delete(id);
                updateSelectionBar();
            });
        });
    } catch (err) {
        showErrorBanner('contactsError', 'Failed to load contacts.', loadContacts);
    }
}

function updateSelectionBar() {
    const bar = document.getElementById('contactsSelectionBar');
    const count = document.getElementById('contactsSelectionCount');
    if (!bar || !count) return;
    const n = SELECTED_CONTACTS.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    count.textContent = `${n} contact${n === 1 ? '' : 's'} selected`;
    if (typeof hydrateIcons === 'function') hydrateIcons(bar);
}

/**
 * Replaces the current selection with the next `n` contacts due for
 * outreach — "due" meaning never sent one before, unless the
 * "include already-reached" box is checked. Pulls from whatever's
 * currently loaded (respects the active search filter) in the order the
 * table shows them, so clicking this repeatedly after each send batch
 * naturally works through the list without hand-picking rows.
 */
function quickSelectNext(n) {
    const includeReached = document.getElementById('quickSelectIncludeReached').checked;
    const pool = LAST_LOADED_CONTACTS.filter(c => includeReached || !c.last_outreach_at);
    const picked = pool.slice(0, n);

    SELECTED_CONTACTS.clear();
    picked.forEach(c => SELECTED_CONTACTS.set(c.id, { id: c.id, phone: c.phone, name: c.name, reached: !!c.last_outreach_at }));

    document.querySelectorAll('.contact-row-check').forEach(cb => {
        cb.checked = SELECTED_CONTACTS.has(Number(cb.dataset.id));
    });
    document.getElementById('contactsSelectAll').checked = picked.length > 0 && picked.length === LAST_LOADED_CONTACTS.length;
    updateSelectionBar();

    if (picked.length === 0) {
        showToast(includeReached ? 'No contacts to select' : 'Everyone in this list has already been reached — check "include already-reached" to pick anyway', 'info');
    } else if (picked.length < n) {
        showToast(`Only ${picked.length} contact${picked.length === 1 ? '' : 's'} available — selected all of them`, 'info');
    } else {
        showToast(`Selected ${picked.length} contacts`, 'success');
    }
}

async function deleteContact(id) {
    if (!confirm('Are you sure you want to delete this contact?')) return;
    const numId = parseInt(id, 10);
    const btn = document.querySelector(`[data-action="delete-contact"][data-id="${numId}"]`);
    if (btn) btn.disabled = true;

    try {
        await api(`/api/contacts/${numId}`, { method: 'DELETE' });
        SELECTED_CONTACTS.delete(numId);
        updateSelectionBar();
        showToast('Contact deleted successfully', 'success');
        const row = btn ? btn.closest('tr') : null;
        if (row) row.remove();
        await loadContacts();
    } catch (err) {
        showToast(err.message || 'Failed to delete contact', 'error');
        if (btn) btn.disabled = false;
    }
}
window.deleteContact = deleteContact;

// ─── CSV import ─────────────────────────────────────────────
function downloadCsvTemplate() {
    const csv = 'phone,name,label,notes\n919876543210,Jane Doe,Customer,Met at the trade show\n919812345678,John Smith,Lead,';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'contacts_template.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function handleCsvFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('csvFileName').textContent = file.name;

    // 1MB matches the server's JSON body limit — catch an oversized file
    // client-side with a clear reason instead of a generic request-failed error.
    if (file.size > 1024 * 1024) {
        showToast('That file is too large (over 1MB) — split it into smaller files and import each separately', 'error');
        e.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
        const resultBox = document.getElementById('csvImportResult');
        resultBox.style.display = 'block';
        resultBox.innerHTML = `<p style="color:var(--color-text-secondary)">Importing…</p>`;
        try {
            const result = await api('/api/contacts/import', {
                method: 'POST',
                body: JSON.stringify({ csv: reader.result })
            });
            const parts = [];
            if (result.imported) parts.push(`${result.imported} added`);
            if (result.updated)  parts.push(`${result.updated} updated`);
            if (result.skipped)  parts.push(`${result.skipped} skipped`);
            resultBox.innerHTML = `
                <p style="color:var(--color-success);font-weight:600">
                    ${Icon('check-circle')} Import complete — ${parts.join(', ') || 'nothing to do'} (of ${result.total} rows).
                </p>
                ${result.errors.length ? `
                    <details style="margin-top:8px">
                        <summary style="cursor:pointer;color:var(--color-text-secondary);font-size:.85rem">${result.errors.length} row${result.errors.length === 1 ? '' : 's'} skipped — why</summary>
                        <ul style="font-size:.8rem;color:var(--color-text-secondary);margin-top:6px">
                            ${result.errors.slice(0, 50).map(e => `<li>Row ${e.row}: ${escapeHtml(e.reason)}</li>`).join('')}
                            ${result.errors.length > 50 ? `<li>…and ${result.errors.length - 50} more</li>` : ''}
                        </ul>
                    </details>` : ''}
            `;
            showToast('CSV import complete', 'success');
            loadContacts();
        } catch (err) {
            resultBox.innerHTML = `<p style="color:var(--color-error)">${Icon('x-circle')} ${escapeHtml(err.message || 'Import failed')}</p>`;
        } finally {
            e.target.value = '';
        }
    };
    reader.onerror = () => showToast('Could not read that file', 'error');
    reader.readAsText(file);
}

// ─── Bulk outreach ──────────────────────────────────────────
let OUTREACH_POLL_TIMER = null;

function openOutreachModal() {
    if (SELECTED_CONTACTS.size === 0) return;
    const total = SELECTED_CONTACTS.size;
    const alreadyReached = Array.from(SELECTED_CONTACTS.values()).filter(c => c.reached).length;

    let recipText = `Sending to ${total} contact${total === 1 ? '' : 's'}`;
    if (alreadyReached > 0) {
        recipText += ` — <span style="color:var(--color-warning)">${alreadyReached} of these ${alreadyReached === 1 ? 'has' : 'have'} already been sent an outreach message before</span>`;
    }
    document.getElementById('outreachRecipientCount').innerHTML = recipText;

    document.getElementById('outreachMessage').value = '';
    document.getElementById('outreachComposeView').style.display = '';
    document.getElementById('outreachProgressView').style.display = 'none';
    document.getElementById('outreachSendBtn').disabled = false;
    document.getElementById('outreachModalBackdrop').style.display = 'flex';
    if (typeof hydrateIcons === 'function') hydrateIcons(document.getElementById('outreachModalBackdrop'));
}

function closeOutreachModal() {
    if (OUTREACH_POLL_TIMER) { clearTimeout(OUTREACH_POLL_TIMER); OUTREACH_POLL_TIMER = null; }
    document.getElementById('outreachModalBackdrop').style.display = 'none';
}

async function submitOutreach() {
    const message = document.getElementById('outreachMessage').value.trim();
    if (!message) { showToast('Write a message first', 'error'); return; }

    const btn = document.getElementById('outreachSendBtn');
    btn.disabled = true;

    try {
        const contactIds = Array.from(SELECTED_CONTACTS.keys());
        const { jobId, total } = await api('/api/contacts/outreach', {
            method: 'POST',
            body: JSON.stringify({ contactIds, message })
        });

        document.getElementById('outreachComposeView').style.display = 'none';
        document.getElementById('outreachProgressView').style.display = 'block';
        document.getElementById('outreachDoneBtn').style.display = 'none';
        document.getElementById('outreachProgressList').innerHTML = '';
        document.getElementById('outreachProgressSummary').textContent = `Sending to ${total} contacts — this runs in the background with a delay between each send, so it'll take a while. You can close this and it'll keep going.`;

        pollOutreachJob(jobId);
    } catch (err) {
        showToast(err.message || 'Could not start outreach', 'error');
        btn.disabled = false;
    }
}

async function pollOutreachJob(jobId) {
    try {
        const job = await api(`/api/contacts/outreach/${jobId}`);
        const list = document.getElementById('outreachProgressList');
        list.innerHTML = job.results.map(r => `
            <div class="outreach-progress-row ${r.status === 'sent' ? 'ok' : 'fail'}">
                <span>${escapeHtml(r.name || r.phone)}</span>
                <span>${r.status === 'sent' ? Icon('check-circle') : (r.reason ? escapeHtml(r.reason) : 'failed')}</span>
            </div>
        `).join('');

        const doneCount = job.sent + job.failed + job.skipped;
        document.getElementById('outreachProgressSummary').textContent =
            job.status === 'done'
                ? `Done — ${job.sent} sent, ${job.failed} failed, ${job.skipped} skipped.`
                : `Sending… ${doneCount}/${job.total} processed so far.`;

        if (job.status === 'done') {
            document.getElementById('outreachDoneBtn').style.display = '';
            showToast(`Outreach finished — ${job.sent} sent`, job.failed > job.sent ? 'error' : 'success');
            SELECTED_CONTACTS.clear();
            loadContacts();
        } else {
            OUTREACH_POLL_TIMER = setTimeout(() => pollOutreachJob(jobId), 2000);
        }
    } catch (err) {
        document.getElementById('outreachProgressSummary').textContent = 'Lost track of this job — it may still be sending in the background.';
    }
}

// ═══════════════════════════════════════════════════════════
//  SCHEDULED MESSAGES
// ═══════════════════════════════════════════════════════════
async function loadScheduled() {
    clearErrorBanner('scheduledError');
    try {
        const messages = await api('/api/scheduled');
        const tbody    = document.getElementById('scheduledBody');

        if (messages.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">⏰</span>
                            <div class="empty-state-title">No scheduled messages</div>
                            <p>Schedule your first message above!</p>
                        </div>
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = messages.map(msg => `
            <tr>
                <td style="color:var(--color-text-secondary)">${escapeHtml(msg.phone)}</td>
                <td><span class="msg-truncate">${escapeHtml(msg.body)}</span></td>
                <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(msg.scheduled_at)}</td>
                <td>
                    <span class="pill pill-${msg.status === 'pending' ? 'pending' : msg.status === 'sent' ? 'active' : 'error'}">
                        ${escapeHtml(msg.status)}
                    </span>
                </td>
                <td>
                    ${msg.status === 'pending'
                        ? `<button class="btn btn-sm btn-danger" data-action="cancel-scheduled" data-id="${msg.id}" aria-label="Cancel scheduled message" type="button">Cancel</button>`
                        : '—'}
                </td>
            </tr>
        `).join('');
    } catch (err) {
        showErrorBanner('scheduledError', 'Failed to load scheduled messages.', loadScheduled);
    }
}

async function cancelScheduled(id) {
    if (!confirm('Cancel this scheduled message?')) return;
    try {
        await api(`/api/scheduled/${id}`, { method: 'DELETE' });
        showToast('Scheduled message cancelled', 'success');
        loadScheduled();
    } catch (err) {
        showToast('Failed to cancel', 'error');
    }
}

// ═══════════════════════════════════════════════════════════
//  APPOINTMENTS
// ═══════════════════════════════════════════════════════════
async function loadAppointments() {
    clearErrorBanner('appointmentsError');
    try {
        const { appointments } = await api('/api/appointments');
        const tbody = document.getElementById('appointmentsBody');

        if (appointments.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5">
                        <div class="empty-state">
                            <span class="empty-state-icon" aria-hidden="true">${Icon('calendar-clock')}</span>
                            <div class="empty-state-title">No appointments yet</div>
                            <p>Bookings made by your chatbot or added manually below will show up here.</p>
                        </div>
                    </td>
                </tr>`;
        } else {
            tbody.innerHTML = appointments.map(a => `
                <tr>
                    <td>
                        <strong>${escapeHtml(a.contact_name || a.phone)}</strong>
                        ${a.contact_name ? `<br><small style="color:var(--color-text-secondary)">${escapeHtml(a.phone)}</small>` : ''}
                    </td>
                    <td style="white-space:nowrap;color:var(--color-text-secondary)">${formatDate(a.start_at)}</td>
                    <td>${a.source === 'chatbot' ? Icon('bot', 'icon-inline') + ' Chatbot' : Icon('user', 'icon-inline') + ' Manual'}</td>
                    <td>
                        <span class="pill pill-${a.status === 'confirmed' ? 'active' : 'error'}">${escapeHtml(a.status)}</span>
                    </td>
                    <td>
                        ${a.status === 'confirmed'
                            ? `<button class="btn btn-sm btn-danger" data-action="cancel-appointment" data-id="${a.id}" aria-label="Cancel appointment" type="button">Cancel</button>`
                            : '—'}
                    </td>
                </tr>
            `).join('');
        }

        document.getElementById('apptBookingDisabledNotice').style.display = 'none';
    } catch (err) {
        showErrorBanner('appointmentsError', 'Failed to load appointments.', loadAppointments);
    }

    loadApptSlotOptions();
}

async function cancelAppointment(id) {
    if (!confirm('Cancel this appointment?')) return;
    try {
        await api(`/api/appointments/${id}`, { method: 'DELETE' });
        showToast('Appointment cancelled', 'success');
        loadAppointments();
    } catch (err) {
        showToast(err.message || 'Failed to cancel appointment', 'error');
    }
}

async function loadApptSlotOptions() {
    const select = document.getElementById('apptSlotSelect');
    if (!select) return;
    select.innerHTML = '<option value="">Loading available slots…</option>';
    try {
        const { slots, settings } = await api('/api/appointments/slots?daysAhead=14&maxResults=30');
        if (!settings.bookingEnabled) {
            const notice = document.getElementById('apptBookingDisabledNotice');
            if (notice) notice.style.display = '';
        }
        if (slots.length === 0) {
            select.innerHTML = '<option value="">No open slots in the next 14 days</option>';
            return;
        }
        select.innerHTML = slots.map(s => `<option value="${escapeHtml(s.startIso)}">${escapeHtml(s.label)}</option>`).join('');
    } catch (err) {
        select.innerHTML = '<option value="">Could not load slots</option>';
    }
}

// ═══════════════════════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════════════════════
async function loadSettings() {
    try {
        const settings = await api('/api/settings');

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = val === 'true';
            else el.value = val || '';
        };

        set('settBusinessName',   settings.business_name);
        set('settChatbotEnabled', settings.chatbot_enabled);
        set('settDefaultReply',   settings.default_reply);
        set('settAwayMode',       settings.away_mode);
        set('settAwayMessage',    settings.away_message);
        set('settWelcomeMessage', settings.welcome_message);
        set('settAiEnabled',      settings.ai_enabled);
        set('settOwnerName',      settings.owner_name);
        set('settAiMode',         settings.ai_mode || 'ai_first');
        set('settAiSystemPrompt', settings.ai_system_prompt);
        const keyInput = document.getElementById('settGeminiApiKey');
        const statusBadge = document.getElementById('settGeminiApiKeyStatus');
        const removeBtn = document.getElementById('removeGeminiApiKeyBtn');
        const helpText = document.getElementById('settGeminiApiKeyHelp');

        if (keyInput) {
            keyInput.value = '';
            if (settings.gemini_api_key_set) {
                keyInput.placeholder = '•••••••••••••••• (Key saved — leave blank to keep)';
                if (statusBadge) {
                    statusBadge.style.display = 'inline-block';
                    statusBadge.style.backgroundColor = 'rgba(34, 197, 94, 0.15)';
                    statusBadge.style.color = '#22c55e';
                    statusBadge.textContent = 'Active ✓';
                }
                if (removeBtn) removeBtn.style.display = 'inline-block';
                if (helpText) helpText.innerHTML = 'Key is securely configured. Leave blank to keep current key, or enter a new key to update. Get a key from <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.';
            } else {
                keyInput.placeholder = 'Enter your Gemini API Key';
                if (statusBadge) {
                    statusBadge.style.display = 'inline-block';
                    statusBadge.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                    statusBadge.style.color = '#ef4444';
                    statusBadge.textContent = 'Not Set';
                }
                if (removeBtn) removeBtn.style.display = 'none';
                if (helpText) helpText.innerHTML = 'Get a free key from <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.';
            }
        }

        const savedModel = settings.gemini_model || 'auto';
        const modelSelect = document.getElementById('settGeminiModel');
        const customWrapper = document.getElementById('customModelWrapper');
        const customInput = document.getElementById('settGeminiCustomModel');

        if (modelSelect) {
            const knownOptions = Array.from(modelSelect.options).map(o => o.value);
            if (knownOptions.includes(savedModel)) {
                modelSelect.value = savedModel;
                if (customWrapper) customWrapper.style.display = 'none';
            } else {
                modelSelect.value = 'custom';
                if (customWrapper) {
                    customWrapper.style.display = 'block';
                    if (customInput) customInput.value = savedModel;
                }
            }
        }

        // Business Setup tab data
        loadBusiness();
    } catch (err) {
        showToast('Failed to load settings', 'error');
    }

    loadCalendarStatus();
    loadBookingSettings();
}

// ─── Appointment Booking ─────────────────────────────────────
async function loadBookingSettings() {
    try {
        const s = await api('/api/appointments/settings');
        document.getElementById('bookingEnabled').checked = !!s.bookingEnabled;
        document.querySelectorAll('.bookingDay').forEach(cb => {
            cb.checked = s.workingDays.includes(Number(cb.value));
        });
        document.getElementById('bookingStartTime').value = s.startTime;
        document.getElementById('bookingEndTime').value = s.endTime;
        document.getElementById('bookingSlotDuration').value = String(s.slotDurationMinutes);
        document.getElementById('bookingBufferMinutes').value = String(s.bufferMinutes);

        const tzSelect = document.getElementById('bookingTimezone');
        // The dropdown only lists common zones — if the saved value isn't
        // one of them (set via an older version, or a zone we don't list),
        // add it so the picker doesn't silently fall back to whatever the
        // first <option> happens to be and then overwrite a real setting
        // the next time the form is saved.
        if (tzSelect && ![...tzSelect.options].some(o => o.value === s.timezone)) {
            const opt = document.createElement('option');
            opt.value = s.timezone;
            opt.textContent = s.timezone;
            tzSelect.appendChild(opt);
        }
        if (tzSelect) tzSelect.value = s.timezone;
    } catch (err) {
        showToast('Failed to load booking settings', 'error');
    }
}

function initBookingSettings() {
    const form = document.getElementById('bookingSettingsForm');
    if (!form) return; // booking tab not on this page

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const workingDays = Array.from(document.querySelectorAll('.bookingDay:checked')).map(cb => Number(cb.value));
        if (workingDays.length === 0) {
            showToast('Pick at least one working day', 'error');
            return;
        }

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        try {
            await api('/api/appointments/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    workingDays,
                    startTime: document.getElementById('bookingStartTime').value,
                    endTime: document.getElementById('bookingEndTime').value,
                    slotDurationMinutes: Number(document.getElementById('bookingSlotDuration').value),
                    bufferMinutes: Number(document.getElementById('bookingBufferMinutes').value),
                    timezone: document.getElementById('bookingTimezone').value,
                    bookingEnabled: document.getElementById('bookingEnabled').checked
                })
            });
            showToast('Booking settings saved!', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to save booking settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Booking Settings';
        }
    });

    // The enable toggle lives outside the form (it reads like a feature
    // switch, not a form field) but should save immediately like the
    // calendar's own availability toggle does.
    document.getElementById('bookingEnabled')?.addEventListener('change', async (e) => {
        try {
            const s = await api('/api/appointments/settings');
            await api('/api/appointments/settings', {
                method: 'PUT',
                body: JSON.stringify({ ...s, bookingEnabled: e.target.checked })
            });
            showToast(e.target.checked ? 'Chatbot booking enabled' : 'Chatbot booking disabled', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to update', 'error');
            e.target.checked = !e.target.checked;
        }
    });
}

// ─── Google Calendar ────────────────────────────────────────
async function loadCalendarStatus() {
    const statusEl = document.getElementById('calendarStatus');
    const notConfiguredEl = document.getElementById('calendarNotConfigured');
    const connectBtn = document.getElementById('calendarConnectBtn');
    const syncBtn = document.getElementById('calendarSyncBtn');
    const disconnectBtn = document.getElementById('calendarDisconnectBtn');
    const availabilityRow = document.getElementById('calendarAvailabilityRow');
    if (!statusEl) return; // calendar tab not on this page

    try {
        const data = await api('/api/calendar/status');
        if (!data.configured) {
            notConfiguredEl.style.display = '';
            statusEl.innerHTML = '';
            connectBtn.style.display = 'none';
            syncBtn.style.display = 'none';
            disconnectBtn.style.display = 'none';
            availabilityRow.style.display = 'none';
            return;
        }
        notConfiguredEl.style.display = 'none';

        if (data.connected) {
            statusEl.innerHTML = `<p class="connected-text">${Icon('check-circle', 'icon-inline')}Connected${data.lastSyncAt ? ` — last synced ${new Date(data.lastSyncAt).toLocaleString()}` : ''}</p>`;
            connectBtn.style.display = 'none';
            syncBtn.style.display = '';
            disconnectBtn.style.display = '';
            availabilityRow.style.display = '';
            const cb = document.getElementById('settCalendarCheckAvailability');
            if (cb) cb.checked = !!data.checkAvailability;
        } else {
            statusEl.innerHTML = `<p style="color:var(--color-text-secondary)">${Icon('x-circle', 'icon-inline')}Not connected</p>`;
            connectBtn.style.display = '';
            syncBtn.style.display = 'none';
            disconnectBtn.style.display = 'none';
            availabilityRow.style.display = 'none';
        }
    } catch (err) {
        statusEl.innerHTML = '<p style="color:var(--color-error)">Could not load calendar status</p>';
    }
}

function initCalendarSettings() {
    const connectBtn = document.getElementById('calendarConnectBtn');
    const syncBtn = document.getElementById('calendarSyncBtn');
    const disconnectBtn = document.getElementById('calendarDisconnectBtn');
    const availabilityToggle = document.getElementById('settCalendarCheckAvailability');
    if (!connectBtn) return; // calendar tab not on this page

    connectBtn.addEventListener('click', async () => {
        try {
            const data = await api('/api/calendar/connect');
            // A popup keeps the dashboard tab alive so status can refresh via
            // postMessage the moment the OAuth flow finishes.
            window.open(data.url, 'google-calendar-connect', 'width=520,height=680');
        } catch (err) {
            showToast(err.message || 'Could not start Google Calendar connection', 'error');
        }
    });

    syncBtn.addEventListener('click', async () => {
        syncBtn.disabled = true;
        try {
            const data = await api('/api/calendar/sync', { method: 'POST' });
            showToast(data.imported > 0 ? `Imported ${data.imported} event(s)` : 'No new calendar events to import', 'success');
            loadCalendarStatus();
        } catch (err) {
            showToast(err.message || 'Sync failed', 'error');
        } finally {
            syncBtn.disabled = false;
        }
    });

    disconnectBtn.addEventListener('click', async () => {
        if (!confirm('Disconnect Google Calendar? Outreach will stop being logged and calendar events will no longer be imported.')) return;
        try {
            await api('/api/calendar/disconnect', { method: 'POST' });
            showToast('Google Calendar disconnected', 'success');
            loadCalendarStatus();
        } catch (err) {
            showToast(err.message || 'Could not disconnect', 'error');
        }
    });

    if (availabilityToggle) {
        availabilityToggle.addEventListener('change', async () => {
            try {
                await api('/api/calendar/settings', {
                    method: 'PUT',
                    body: JSON.stringify({ checkAvailability: availabilityToggle.checked })
                });
                showToast('Saved', 'success');
            } catch (err) {
                showToast(err.message || 'Could not save', 'error');
                availabilityToggle.checked = !availabilityToggle.checked;
            }
        });
    }

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data && event.data.type === 'google-calendar-connected') {
            if (event.data.ok) showToast('Google Calendar connected', 'success');
            else showToast(event.data.message || 'Could not connect Google Calendar', 'error');
            loadCalendarStatus();
        }
    });
}

// ─── QR / SSE ────────────────────────────────────────────────
// Primary: real-time updates via Server-Sent Events.
// Fallback: if no actionable SSE event arrives within 10s (cloud load
// balancers / proxies sometimes buffer or drop EventSource connections),
// a REST poll to /api/status every 5s ensures the QR code still reaches
// the browser.
let _sseReceivedActionable = false;
let _statusPollTimer = null;

function initSSE() {
    _sseReceivedActionable = false;
    const eventSource = new EventSource('/api/qr-stream');

    eventSource.onmessage = function (event) {
        try {
            const data        = JSON.parse(event.data);
            // Any event other than the initial 'loading' means SSE is working
            if (data.type !== 'loading') _sseReceivedActionable = true;
            applyConnectionState(data);
        } catch (e) {
            console.error('SSE parse error:', e);
        }
    };

    eventSource.onerror = function () {
        console.warn('SSE connection lost — browser will auto-reconnect.');
    };

    // ── REST fallback: kick in if SSE hasn't delivered after 10s ──
    setTimeout(() => {
        if (!_sseReceivedActionable) {
            console.warn('SSE has not delivered a QR/ready event — starting REST polling fallback.');
            startStatusPolling();
        }
    }, 10000);
}

function startStatusPolling() {
    if (_statusPollTimer) return; // already polling
    _statusPollTimer = setInterval(async () => {
        try {
            const res = await api('/api/status');
            const s = res.data || res;
            if (s.connected) {
                applyConnectionState({ type: 'ready', phone: s.phone });
                stopStatusPolling();
            } else if (s.qr) {
                applyConnectionState({ type: 'qr', data: s.qr });
            } else if (s.error) {
                applyConnectionState({ type: 'error', data: s.error });
            } else if (s.initializing) {
                applyConnectionState({ type: 'loading' });
            }
        } catch (e) {
            // API unreachable — keep polling silently
        }
    }, 5000);
}

function stopStatusPolling() {
    if (_statusPollTimer) { clearInterval(_statusPollTimer); _statusPollTimer = null; }
}

function applyConnectionState(data) {
    const qrLoading   = document.getElementById('qrLoading');
    const qrImage     = document.getElementById('qrImage');
    const qrSuccess   = document.getElementById('qrSuccess');
    const qrContainer = document.getElementById('qrContainer');
    const statusDot   = document.querySelector('#connectionStatus .status-dot');
    const statusText  = document.querySelector('#connectionStatus .status-text');
    const connInfo    = document.getElementById('connectionInfo');

    const show = (el) => { if (el) el.style.display = ''; };
    const hide = (el) => { if (el) el.style.display = 'none'; };

    // Remove any previous reconnect button if present
    const oldReconnect = document.getElementById('qrReconnectBtnContainer');
    if (oldReconnect) oldReconnect.remove();

    if (data.type === 'qr') {
        show(qrLoading); hide(qrImage); hide(qrSuccess);
        if (qrImage) { qrImage.src = data.data; qrImage.style.display = 'block'; }
        if (qrLoading) qrLoading.style.display = 'none';
        if (statusDot)  statusDot.className  = 'status-dot error';
        if (statusText) statusText.textContent = 'Scan QR Code';
        if (connInfo)   connInfo.innerHTML   = `<p style="color:var(--color-warning)">${Icon('triangle-alert', 'icon-inline')}Waiting for QR Code scan. Go to Settings → WhatsApp QR.</p>`;

    } else if (data.type === 'ready') {
        hide(qrLoading); hide(qrImage); show(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot connected';
        if (statusText) statusText.textContent = 'Connected';
        if (connInfo)   connInfo.innerHTML   = `
            <p class="connected-text">${Icon('check-circle', 'icon-inline')}Connected to WhatsApp</p>
            <p>Phone: ${escapeHtml(data.phone || '')}</p>`;

    } else if (data.type === 'disconnected' || data.type === 'error') {
        hide(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot error';
        if (statusText) statusText.textContent = 'Disconnected';
        if (connInfo)   connInfo.innerHTML   = `<p style="color:var(--color-error)">${Icon('x-circle', 'icon-inline')}Not connected</p>`;

        if (qrContainer && !document.getElementById('qrReconnectBtnContainer')) {
            const reconnectDiv = document.createElement('div');
            reconnectDiv.id = 'qrReconnectBtnContainer';
            reconnectDiv.style.textAlign = 'center';
            reconnectDiv.style.padding = '24px 16px';

            // Only show connect button if admin has granted WA access to this user
            const waAllowed = CURRENT_USER && (CURRENT_USER.role === 'admin' || CURRENT_USER.wa_enabled);

            if (waAllowed) {
                reconnectDiv.innerHTML = `
                    <p style="color:var(--color-error);font-weight:600;margin-bottom:12px;">${Icon('x-circle', 'icon-inline')} WhatsApp is Disconnected</p>
                    <button class="btn btn-primary btn-sm" id="reconnectWaBtn" type="button" style="display:inline-flex;align-items:center;gap:6px;">${Icon('refresh-cw', 'icon-inline')} Connect &amp; Show QR Code</button>
                `;
                qrContainer.appendChild(reconnectDiv);
                document.getElementById('reconnectWaBtn')?.addEventListener('click', async () => {
                    reconnectDiv.innerHTML = `<div class="qr-loading">${Icon('loader', 'icon-inline')} Starting WhatsApp Client…</div>`;
                    try {
                        await api('/api/whatsapp/connect', { method: 'POST' });
                        applyConnectionState({ type: 'loading' });
                    } catch (e) {
                        showToast(e.message || 'Failed to start connection', 'error');
                    }
                });
            } else {
                reconnectDiv.innerHTML = `
                    <p style="color:var(--color-error);font-weight:600;margin-bottom:12px;">${Icon('x-circle', 'icon-inline')} WhatsApp is Disconnected</p>
                    <p style="color:var(--color-text-secondary);font-size:.9rem;max-width:340px;margin:0 auto;line-height:1.6;">
                        ${Icon('lock', 'icon-inline')} WhatsApp access has not been enabled for your account. Please contact your administrator.
                    </p>
                `;
                qrContainer.appendChild(reconnectDiv);
            }
        }

    } else if (data.type === 'loading') {
        show(qrLoading); hide(qrImage); hide(qrSuccess);
        if (statusDot)  statusDot.className  = 'status-dot demo';
        if (statusText) statusText.textContent = 'Initializing…';
        if (connInfo)   connInfo.innerHTML   = '<p>Loading WhatsApp Client…</p>';
    }
}


// ═══════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Safely encode an arbitrary string as a JSON attribute value. */
function jsAttr(str) {
    return escapeHtml(JSON.stringify(str == null ? '' : String(str)));
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + (dateStr.includes('Z') || dateStr.includes('+') ? '' : 'Z'));
    if (isNaN(d)) return '';
    const diffMins = Math.floor((Date.now() - d) / 60000);
    if (diffMins < 1)  return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24)  return `${diffHrs}h ago`;
    return `${Math.floor(diffHrs / 24)}d ago`;
}

// ═══════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {

    // ── Icons ────────────────────────────────────────────────
    // Hydrates every static [data-icon] element written in index.html into
    // an inline SVG (see js/icons.js). Dynamic content rendered by this file
    // calls Icon() directly inside its template strings instead.
    if (typeof hydrateIcons === 'function') hydrateIcons();

    // ── Auth gate ────────────────────────────────────────────
    // Redirects to /login if there's no valid session — nothing else on
    // this page should run for a logged-out visitor.
    const authed = await checkAuth();
    if (!authed) return;

    // ── Prevent any unwanted modals/overlays from popping up on login ──
    ['dealModalBackdrop', 'outreachModalBackdrop', 'editProductModalBackdrop', 'imageLightboxBackdrop'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = 'none';
            el.classList.remove('show');
        }
    });

    // ── Event Delegation for Action Buttons (CSP script-src-attr 'none' compliance) ──
    // 1. Toast close
    document.getElementById('toastContainer')?.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.toast-close');
        if (closeBtn) closeBtn.closest('.toast')?.remove();
    });

    // 2. Products List
    document.getElementById('productList')?.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const id = parseInt(target.dataset.id, 10);
        if (action === 'edit-product') {
            openEditProductModal(id);
        } else if (action === 'toggle-product') {
            const nextActive = parseInt(target.dataset.active, 10);
            toggleProduct(id, nextActive);
        } else if (action === 'delete-product') {
            deleteProductRow(id);
        } else if (action === 'preview-product-image') {
            previewProductImage(target.dataset.src, target.dataset.title);
        }
    });

    // 3. Contacts Table
    const bindContactsDelegation = (tableEl) => {
        tableEl?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="delete-contact"]');
            if (!btn) return;
            const id = parseInt(btn.dataset.id, 10);
            if (!isNaN(id)) deleteContact(id);
        });
    };
    bindContactsDelegation(document.getElementById('contactsBody'));
    bindContactsDelegation(document.getElementById('contactsTable'));
    bindContactsDelegation(document.getElementById('contactsTableBody'));
    bindContactsDelegation(document.getElementById('contacts'));

    // Universal action buttons delegation fallback
    document.addEventListener('click', (e) => {
        const contactDeleteBtn = e.target.closest('[data-action="delete-contact"]');
        if (contactDeleteBtn) {
            const id = parseInt(contactDeleteBtn.dataset.id, 10);
            if (!isNaN(id)) deleteContact(id);
            return;
        }
        const productDeleteBtn = e.target.closest('[data-action="delete-product"]');
        if (productDeleteBtn) {
            const id = parseInt(productDeleteBtn.dataset.id, 10);
            if (!isNaN(id)) deleteProductRow(id);
            return;
        }
    });

    // 4. Chatbot Rules List
    document.getElementById('rulesList')?.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const id = parseInt(target.dataset.id, 10);
        if (action === 'toggle-rule') {
            const nextActive = parseInt(target.dataset.active, 10);
            toggleRule(id, nextActive);
        } else if (action === 'delete-rule') {
            deleteRule(id);
        }
    });

    // 5. Scheduled Messages Table
    document.getElementById('scheduledBody')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="cancel-scheduled"]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id, 10);
        cancelScheduled(id);
    });

    // 6. Appointments Table
    document.getElementById('appointmentsBody')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="cancel-appointment"]');
        if (!btn) return;
        const id = parseInt(btn.dataset.id, 10);
        cancelAppointment(id);
    });

    // 7. Leads List (Pending and Cards)
    document.getElementById('leadsList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="analyze-lead"]');
        if (!btn) return;
        const phone = btn.dataset.phone;
        if (phone) analyzeLead(phone);
    });

    // 8. CRM Kanban Board & Deal Modal
    document.getElementById('kanbanBoard')?.addEventListener('click', (e) => {
        const card = e.target.closest('[data-action="open-deal"]');
        if (!card) return;
        const phone = card.dataset.phone;
        if (phone) openDealModal(phone);
    });

    document.getElementById('dealModalBody')?.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        const id = parseInt(target.dataset.id, 10);
        if (action === 'save-deal') {
            saveDealFromModal(id);
        } else if (action === 'delete-deal') {
            deleteDealFromModal(id);
        } else if (action === 'add-note') {
            addNoteFromModal();
        }
    });

    document.getElementById('logoutBtn')?.addEventListener('click', logout);

    // ── Settings tabs ──────────────────────────────────────
    initSettingsTabs();
    initCalendarSettings();
    initBookingSettings();

    // ── Navigation ─────────────────────────────────────────
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            // Not every sidebar link is a section of this single-page app.
            // The Admin panel is its own page (href="/admin") and carries no
            // data-section — swallowing its click here is what made it
            // highlight the item, blank the content area, and never leave
            // /app. No data-section means "let the browser follow the href".
            if (!item.dataset.section) return;
            e.preventDefault();
            navigateTo(item.dataset.section);
        });
    });

    // ── Mobile menu ─────────────────────────────────────────
    const menuToggle = document.getElementById('menuToggle');
    const sidebar    = document.getElementById('sidebar');
    const overlay    = document.getElementById('overlay');

    menuToggle.addEventListener('click', () => {
        const isOpen = sidebar.classList.toggle('open');
        overlay.classList.toggle('active', isOpen);
        menuToggle.setAttribute('aria-expanded', String(isOpen));
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        menuToggle.setAttribute('aria-expanded', 'false');
    });

    // ── Topbar refresh ──────────────────────────────────────
    document.getElementById('refreshBtn')?.addEventListener('click', () => {
        loadSectionData(currentSection);
        showToast('Refreshed', 'info');
    });

    // ── Dashboard stat tiles → navigate ─────────────────────
    document.querySelectorAll('.stat-clickable[data-goto]').forEach(tile => {
        tile.addEventListener('click', () => navigateTo(tile.dataset.goto));
        tile.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(tile.dataset.goto); }
        });
        tile.setAttribute('tabindex', '0');
    });

    // ── Quick send form ─────────────────────────────────────
    document.getElementById('quickSendForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone   = document.getElementById('qsPhone').value.trim();
        const message = document.getElementById('qsMessage').value.trim();
        if (!phone || !message) return;

        const btn = document.getElementById('quickSendBtn');
        btn.disabled = true;
        btn.textContent = 'Sending…';

        try {
            await api('/api/messages/send', {
                method: 'POST',
                body: JSON.stringify({ phone, body: message })
            });
            showToast(`Message sent to ${phone}`, 'success');
            document.getElementById('qsPhone').value    = '';
            document.getElementById('qsMessage').value  = '';
            loadMessages();
        } catch (err) {
            showToast(err.message || 'Failed to send message', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<span class="btn-icon" aria-hidden="true">${Icon('send')}</span> Send Message`;
        }
    });

    // ── Add chatbot rule ────────────────────────────────────
    document.getElementById('addRuleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const trigger_keyword = document.getElementById('ruleTrigger').value.trim();
        const match_type      = document.getElementById('ruleMatchType').value;
        const response_text   = document.getElementById('ruleResponse').value.trim();
        const priority        = parseInt(document.getElementById('rulePriority').value) || 0;

        if (!trigger_keyword || !response_text) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';

        try {
            await api('/api/chatbot/rules', {
                method: 'POST',
                body: JSON.stringify({ trigger_keyword, match_type, response_text, priority })
            });
            showToast('Rule added successfully!', 'success');
            document.getElementById('addRuleForm').reset();
            document.getElementById('rulePriority').value = '5';
            loadChatbotRules();
        } catch (err) {
            showToast('Failed to add rule', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Rule';
        }
    });

    // ── Test chatbot ────────────────────────────────────────
    document.getElementById('testChatbotBtn').addEventListener('click', testChatbot);
    document.getElementById('testMessage').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); testChatbot(); }
    });

    // ── Add contact form ────────────────────────────────────
    document.getElementById('addContactForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('contactPhone').value.trim();
        const name  = document.getElementById('contactName').value.trim();
        const label = document.getElementById('contactLabel').value.trim();

        if (!phone) return;

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Adding…';

        try {
            await api('/api/contacts', {
                method: 'POST',
                body: JSON.stringify({ phone, name, label })
            });
            showToast('Contact added!', 'success');
            document.getElementById('addContactForm').reset();
            loadContacts();
        } catch (err) {
            showToast('Failed to add contact', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Add Contact';
        }
    });

    // ── Contact search ──────────────────────────────────────
    let contactSearchTimeout;
    document.getElementById('contactSearch').addEventListener('input', () => {
        clearTimeout(contactSearchTimeout);
        contactSearchTimeout = setTimeout(loadContacts, 300);
    });

    // ── CSV import ───────────────────────────────────────────
    document.getElementById('csvFileInput').addEventListener('change', handleCsvFileSelected);
    document.getElementById('downloadCsvTemplate').addEventListener('click', (e) => {
        e.preventDefault();
        downloadCsvTemplate();
    });

    // ── Contacts selection (select-all / clear) ─────────────
    document.getElementById('contactsSelectAll').addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll('.contact-row-check').forEach(cb => {
            cb.checked = checked;
            cb.dispatchEvent(new Event('change'));
        });
    });
    document.getElementById('clearSelectionBtn').addEventListener('click', () => {
        SELECTED_CONTACTS.clear();
        document.querySelectorAll('.contact-row-check').forEach(cb => { cb.checked = false; });
        document.getElementById('contactsSelectAll').checked = false;
        updateSelectionBar();
    });

    // ── Quick-select N for outreach ──────────────────────────
    document.querySelectorAll('.quick-select-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('quickSelectCount').value = btn.dataset.n;
            quickSelectNext(Number(btn.dataset.n));
        });
    });
    document.getElementById('quickSelectBtn').addEventListener('click', () => {
        const n = Math.max(1, parseInt(document.getElementById('quickSelectCount').value, 10) || 0);
        quickSelectNext(n);
    });

    // ── Outreach modal ───────────────────────────────────────
    document.getElementById('openOutreachBtn').addEventListener('click', openOutreachModal);
    document.getElementById('outreachModalClose').addEventListener('click', closeOutreachModal);
    document.getElementById('outreachCancelBtn').addEventListener('click', closeOutreachModal);
    document.getElementById('outreachModalBackdrop').addEventListener('click', (e) => {
        if (e.target.id === 'outreachModalBackdrop') closeOutreachModal();
    });
    document.getElementById('outreachSendBtn').addEventListener('click', submitOutreach);
    document.getElementById('outreachDoneBtn').addEventListener('click', closeOutreachModal);

    // ── Message search & filter ─────────────────────────────
    let messageSearchTimeout;
    document.getElementById('messageSearch').addEventListener('input', () => {
        clearTimeout(messageSearchTimeout);
        messageSearchTimeout = setTimeout(loadMessages, 300);
    });
    document.getElementById('messageFilter').addEventListener('change', loadMessages);

    // ── Global (topbar) search — jumps to Contacts and filters there,
    // since that's the most common "find someone" lookup. Also mirrors
    // the term into Messages' own search box so it's ready if the user
    // clicks over there next.
    const globalSearchEl = document.getElementById('globalSearch');
    globalSearchEl?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const term = globalSearchEl.value.trim();
        if (!term) return;
        const contactSearchEl = document.getElementById('contactSearch');
        const messageSearchEl = document.getElementById('messageSearch');
        if (contactSearchEl) contactSearchEl.value = term;
        if (messageSearchEl) messageSearchEl.value = term;
        navigateTo('contacts');
        loadContacts();
    });

    // ── Lead analysis controls ──────────────────────────────
    document.getElementById('analyzeAllBtn')?.addEventListener('click', analyzeAllLeads);
    document.getElementById('leadInterestFilter')?.addEventListener('change', loadLeads);
    document.getElementById('leadPriorityFilter')?.addEventListener('change', loadLeads);

    // ── CRM controls ────────────────────────────────────────
    document.getElementById('addDealBtn')?.addEventListener('click', () => {
        const card = document.getElementById('addDealCard');
        card.style.display = card.style.display === 'none' ? '' : 'none';
    });

    document.getElementById('addDealForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('dealPhone').value.trim();
        if (!phone) return;
        try {
            await api('/api/crm/deals', {
                method: 'POST',
                body: JSON.stringify({
                    phone,
                    contact_name:     document.getElementById('dealName').value.trim(),
                    deal_value:       document.getElementById('dealValue').value,
                    stage:            document.getElementById('dealStage').value,
                    product_interest: document.getElementById('dealProduct').value.trim()
                })
            });
            showToast('Deal added!', 'success');
            document.getElementById('addDealForm').reset();
            document.getElementById('addDealCard').style.display = 'none';
            loadCrm();
        } catch (err) {
            showToast(err.message || 'Failed to add deal', 'error');
        }
    });

    // Deal modal close handlers
    document.getElementById('dealModalClose')?.addEventListener('click', closeDealModal);
    document.getElementById('dealModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeDealModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDealModal();
    });
    document.getElementById('dealModal')?.addEventListener('click', (e) => e.stopPropagation());

    // ── Business Setup controls ─────────────────────────────
    document.getElementById('businessForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveBusinessBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    business_website:          document.getElementById('bizWebsite').value.trim(),
                    business_industry:         document.getElementById('bizIndustry').value.trim(),
                    business_description:      document.getElementById('bizDescription').value.trim(),
                    business_target_customers: document.getElementById('bizTarget').value.trim(),
                    business_currency:         document.getElementById('bizCurrency').value.trim() || '₹',
                    business_offers:           document.getElementById('bizOffers').value.trim()
                })
            });
            showToast('Business profile saved! The AI will use it right away.', 'success');
        } catch (err) {
            showToast('Failed to save business profile', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Business Profile';
        }
    });

    // ── Product image uploaders & form handling ─────────────
    setupProductImageUploader('prod');
    setupProductImageUploader('editProd');

    document.getElementById('addProductForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('prodName').value.trim();
        if (!name) {
            showToast('Please enter a product name', 'error');
            return;
        }
        const btn = document.getElementById('addProductBtn') || e.target.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
            await api('/api/products', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    price:       document.getElementById('prodPrice').value.trim(),
                    category:    document.getElementById('prodCategory').value.trim(),
                    description: document.getElementById('prodDesc').value.trim(),
                    url:         document.getElementById('prodUrl').value.trim(),
                    image_path:  document.getElementById('prodImagePath')?.value?.trim() || ''
                })
            });
            showToast('Added to catalog!', 'success');
            document.getElementById('addProductForm').reset();
            resetProductImageUploader('prod');
            loadBusiness();
        } catch (err) {
            showToast(err.message || 'Failed to add product', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    document.getElementById('editProductForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editProdId').value;
        const name = document.getElementById('editProdName').value.trim();
        if (!id || !name) {
            showToast('Please enter a product name', 'error');
            return;
        }
        const btn = document.getElementById('editProductSaveBtn');
        if (btn) btn.disabled = true;
        try {
            await api(`/api/products/${id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name,
                    price:       document.getElementById('editProdPrice').value.trim(),
                    category:    document.getElementById('editProdCategory').value.trim(),
                    description: document.getElementById('editProdDesc').value.trim(),
                    url:         document.getElementById('editProdUrl').value.trim(),
                    image_path:  document.getElementById('editProdImagePath')?.value?.trim() || ''
                })
            });
            showToast('Product updated successfully!', 'success');
            closeEditProductModal();
            loadBusiness();
        } catch (err) {
            showToast(err.message || 'Failed to update product', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    });

    document.getElementById('editProductModalClose')?.addEventListener('click', closeEditProductModal);
    document.getElementById('editProductCancelBtn')?.addEventListener('click', closeEditProductModal);
    document.getElementById('editProductModalBackdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeEditProductModal();
    });

    document.getElementById('imageLightboxClose')?.addEventListener('click', closeImageLightbox);
    document.getElementById('imageLightboxBackdrop')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeImageLightbox();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeEditProductModal();
            closeImageLightbox();
        }
    });

    document.getElementById('analyzeBusinessBtn')?.addEventListener('click', analyzeBusiness);

    // ── Schedule message form ───────────────────────────────
    // The <input type="datetime-local"> gives back a value like "2026-08-08T14:30" —
    // your LOCAL wall-clock time, with no timezone info and no seconds. The
    // server compares scheduled_at against SQLite's datetime('now'), which is
    // UTC in "YYYY-MM-DD HH:MM:SS" format. Sending the raw local value through
    // unconverted both (a) uses the wrong separator so the comparison never
    // matches — messages would sit "pending" indefinitely instead of sending
    // on time — and (b) ignores the local/UTC offset, so even once that's
    // fixed the message fires at the wrong wall-clock time for anyone not in
    // UTC. Converting through a real Date object fixes both at once.
    function toSqliteUtc(datetimeLocalValue) {
        const d = new Date(datetimeLocalValue);
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 19).replace('T', ' ');
    }

    const schedDateInput = document.getElementById('schedDate');
    if (schedDateInput) {
        // Guide the native picker away from the past (not all browsers enforce
        // `min` on datetime-local, so this is a UX nudge, not the real guard).
        const pad = n => String(n).padStart(2, '0');
        const now = new Date();
        schedDateInput.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone          = document.getElementById('schedPhone').value.trim();
        const body           = document.getElementById('schedMessage').value.trim();
        const localValue     = document.getElementById('schedDate').value;

        if (!phone || !body || !localValue) return;

        const scheduled_at = toSqliteUtc(localValue);
        if (!scheduled_at) {
            showToast('That date/time doesn\'t look valid.', 'error');
            return;
        }
        if (new Date(localValue).getTime() < Date.now()) {
            showToast('Pick a time in the future — that one has already passed.', 'error');
            return;
        }

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Scheduling…';

        try {
            await api('/api/scheduled', {
                method: 'POST',
                body: JSON.stringify({ phone, body, scheduled_at })
            });
            showToast('Message scheduled!', 'success');
            document.getElementById('scheduleForm').reset();
            loadScheduled();
        } catch (err) {
            showToast(err.message || 'Failed to schedule message', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Schedule Message';
        }
    });

    // ── Manual appointment booking form ─────────────────────
    document.getElementById('apptRefreshSlotsBtn')?.addEventListener('click', loadApptSlotOptions);

    document.getElementById('apptBookForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const phone = document.getElementById('apptPhone').value.trim();
        const contactName = document.getElementById('apptContactName').value.trim();
        const notes = document.getElementById('apptNotes').value.trim();
        const startIso = document.getElementById('apptSlotSelect').value;

        if (!phone || !startIso) {
            showToast('Pick a phone number and an available slot', 'error');
            return;
        }

        const btn = e.target.querySelector('[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Booking…';

        try {
            await api('/api/appointments', {
                method: 'POST',
                body: JSON.stringify({ phone, contactName, notes, startIso })
            });
            showToast('Appointment booked!', 'success');
            document.getElementById('apptBookForm').reset();
            loadAppointments();
        } catch (err) {
            showToast(err.message || 'Failed to book appointment', 'error');
            loadApptSlotOptions();
        } finally {
            btn.disabled = false;
            btn.textContent = 'Book Appointment';
        }
    });

    // ── Settings (General) form ─────────────────────────────
    document.getElementById('settingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveSettingsBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    business_name:   document.getElementById('settBusinessName')?.value  || '',
                    chatbot_enabled: document.getElementById('settChatbotEnabled')?.checked ? 'true' : 'false',
                    default_reply:   document.getElementById('settDefaultReply')?.value  || '',
                    away_mode:       document.getElementById('settAwayMode')?.checked    ? 'true' : 'false',
                    away_message:    document.getElementById('settAwayMessage')?.value   || '',
                    welcome_message: document.getElementById('settWelcomeMessage')?.value || ''
                })
            });
            showToast('Settings saved!', 'success');
        } catch (err) {
            showToast('Failed to save settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save Settings';
        }
    });

    // ── Persona Preset buttons ──────────────────────────────
    const PRESETS = {
        casual:       `You are a real, friendly AI chatting on WhatsApp on behalf of your owner.\n- Talk naturally, casually, and warmly, just like a real person texting on WhatsApp.\n- Keep responses short (1-3 sentences), concise, and conversational.\n- Answer questions directly, chat with friends or clients, and be helpful.\n- If someone asks personal details you don't know, politely say you'll let the owner know.\n- Use occasional emojis naturally 😊.`,
        assistant:    `You are the personal AI assistant for your owner on WhatsApp.\n- Politely assist whoever is reaching out.\n- Help answer common questions, take down messages, or provide useful details.\n- If urgent, ask them to leave a clear note so the owner can follow up directly.\n- Maintain a polite, helpful, and organized tone.`,
        professional: `You are an AI replying on WhatsApp for professional and business communications.\n- Respond with clarity, courtesy, and efficiency.\n- Keep answers crisp, structured, and informative.\n- If asked for estimates, bookings, or confidential info, politely request their contact details/requirements so the owner can review.`,
        short:        `You are texting on WhatsApp on behalf of your owner.\n- Keep all replies extremely short (1 sentence or a few words max).\n- Direct, friendly, and concise. No fluff or extra explanations.`
    };

    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.preset;
            if (PRESETS[key]) {
                const promptArea = document.getElementById('settAiSystemPrompt');
                if (promptArea) promptArea.value = PRESETS[key];
                showToast(`Applied ${btn.textContent.trim()} preset!`, 'success');
            }
        });
    });

    // ── AI Settings form ────────────────────────────────────
    document.getElementById('aiSettingsForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveAiBtn');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        try {
            const payload = {
                ai_enabled:       document.getElementById('settAiEnabled')?.checked   ? 'true' : 'false',
                owner_name:       document.getElementById('settOwnerName')?.value     || '',
                ai_mode:          document.getElementById('settAiMode')?.value        || 'ai_first',
                ai_system_prompt: document.getElementById('settAiSystemPrompt')?.value || ''
            };

            // If AI is enabled, ensure chatbot auto-replies are enabled
            if (payload.ai_enabled === 'true') {
                payload.chatbot_enabled = 'true';
                const cb = document.getElementById('settChatbotEnabled');
                if (cb) cb.checked = true;
            }

            const newKey = document.getElementById('settGeminiApiKey')?.value?.trim();
            // Only send gemini_api_key if user typed something new. Leaving blank keeps current key!
            if (newKey) {
                payload.gemini_api_key = newKey;
            }

            const modelSelect = document.getElementById('settGeminiModel');
            let chosenModel = modelSelect?.value || 'auto';
            if (chosenModel === 'custom') {
                chosenModel = document.getElementById('settGeminiCustomModel')?.value?.trim() || 'auto';
            }
            payload.gemini_model = chosenModel;

            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            showToast('AI Persona Settings saved!', 'success');
            loadSettings();
            loadDashboard();
        } catch (err) {
            showToast('Failed to save AI settings', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Save AI Persona Settings';
        }
    });

    // ── Gemini Model Custom Toggle ───────────────────────────
    document.getElementById('settGeminiModel')?.addEventListener('change', (e) => {
        const customWrapper = document.getElementById('customModelWrapper');
        if (customWrapper) {
            customWrapper.style.display = e.target.value === 'custom' ? 'block' : 'none';
        }
    });

    // ── Test Gemini API Key ─────────────────────────────────
    document.getElementById('testGeminiApiKeyBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('testGeminiApiKeyBtn');
        const keyInput = document.getElementById('settGeminiApiKey');
        const keyVal = keyInput?.value?.trim();
        const modelSelect = document.getElementById('settGeminiModel');
        let preferredModel = modelSelect?.value || 'auto';
        if (preferredModel === 'custom') {
            preferredModel = document.getElementById('settGeminiCustomModel')?.value?.trim() || '';
        }

        btn.disabled = true;
        btn.textContent = 'Testing…';
        try {
            const data = await api('/api/settings/test-gemini', {
                method: 'POST',
                body: JSON.stringify({ key: keyVal || '', model: preferredModel || '' })
            });
            const modelName = data?.model || data?.data?.model || 'Gemini';
            showToast(`Gemini connected successfully! (Model: ${modelName})`, 'success');
            if (keyVal) {
                showToast('Key is valid! Click "Save AI Persona Settings" to save it.', 'info');
            }
        } catch (err) {
            showToast(err.message || 'Gemini test failed', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Test Key';
        }
    });

    // ── Remove Gemini API Key ───────────────────────────────
    document.getElementById('removeGeminiApiKeyBtn')?.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to remove your Gemini API key? AI auto-replies will stop working until a new key is provided.')) return;
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({ gemini_api_key: '' })
            });
            showToast('Gemini API key removed', 'success');
            loadSettings();
            loadDashboard();
        } catch (err) {
            showToast('Failed to remove API key', 'error');
        }
    });

    // ── Danger Zone buttons ─────────────────────────────────
    document.getElementById('pauseChatbotBtn')?.addEventListener('click', async () => {
        if (!confirm('Pause the chatbot? Auto-replies will stop until you re-enable it in General settings.')) return;
        try {
            await api('/api/settings', {
                method: 'PUT',
                body: JSON.stringify({ chatbot_enabled: 'false' })
            });
            // Reflect in General tab
            const el = document.getElementById('settChatbotEnabled');
            if (el) el.checked = false;
            showToast('Chatbot paused', 'success');
        } catch (err) {
            showToast('Failed to pause chatbot', 'error');
        }
    });

    document.getElementById('clearMessagesBtn')?.addEventListener('click', async () => {
        if (!confirm('Permanently delete ALL stored messages? This cannot be undone.')) return;
        try {
            await api('/api/messages', { method: 'DELETE' });
            showToast('Message history cleared', 'success');
            if (currentSection === 'messages') loadMessages();
            if (currentSection === 'dashboard') loadDashboard();
        } catch (err) {
            showToast(err.message || 'Failed to clear message history', 'error');
        }
    });

    document.getElementById('disconnectBtn')?.addEventListener('click', async () => {
        if (!confirm('Disconnect this WhatsApp number? You can reconnect any time by scanning a new QR code.')) return;
        try {
            await api('/api/whatsapp/disconnect', { method: 'POST' });
            applyConnectionState({ type: 'disconnected' });
            showToast('WhatsApp disconnected.', 'success');
            if (currentSection === 'dashboard') loadDashboard();
        } catch (err) {
            showToast(err.message || 'Failed to disconnect', 'error');
        }
    });

    // ── Initial load ────────────────────────────────────────
    loadDashboard();
    initSSE();

    // ── Auto-refresh active section every 15 s ───────────────────
    setInterval(() => {
        // Skip background refresh if user is currently typing in an input or modal is open
        const isEditing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
        const isModalOpen = document.querySelector('.modal-backdrop[style*="display: block"], .modal-backdrop:not([style*="display: none"]):not([style*="display:none"])');
        if (isEditing || isModalOpen) return;

        if (currentSection === 'dashboard') {
            loadDashboard();
        } else if (currentSection === 'messages') {
            loadMessages();
        } else if (currentSection === 'leads') {
            loadLeads();
        } else if (currentSection === 'crm') {
            loadCrm();
        }
    }, 15000);
});
