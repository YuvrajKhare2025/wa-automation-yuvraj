let ALL_USERS = [];
let CURRENT_ADMIN = null;
let CURRENT_FILTER = 'all';
let CURRENT_ACCESS_TOKEN = null;
let _refreshPromise = null;

async function refreshSession() {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
        try {
            const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                if (data.accessToken) {
                    CURRENT_ACCESS_TOKEN = data.accessToken;
                    return true;
                }
            }
        } catch (e) {
            console.warn('[Admin Auth] Session refresh network error:', e.message);
        } finally {
            _refreshPromise = null;
        }
        return false;
    })();
    return _refreshPromise;
}

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof hydrateIcons === 'function') hydrateIcons();

    closeEditModal();

    const ok = await checkAdminAuth();
    if (!ok) return;

    initFilterBar();
    await Promise.all([loadPlatformStats(), loadUsers()]);

    document.getElementById('userSearch').addEventListener('input', renderUsers);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
    document.getElementById('editSaveBtn').addEventListener('click', saveEditModal);
    document.getElementById('editModalBackdrop').addEventListener('click', (e) => {
        if (e.target.id === 'editModalBackdrop') closeEditModal();
    });

    const viewPendingBtn = document.getElementById('viewPendingBtn');
    if (viewPendingBtn) {
        viewPendingBtn.addEventListener('click', () => setFilter('pending'));
    }

    // ─── Event delegation for table action buttons ────────────
    // Replaces all onclick="" attributes (blocked by CSP script-src-attr 'none').
    // All buttons use data-action + data-id (+ data-value for toggles).
    document.getElementById('usersBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const id = parseInt(btn.dataset.id, 10);
        const value = btn.dataset.value;
        switch (action) {
            case 'approve':     approveUser(id); break;
            case 'reject':      rejectUser(id); break;
            case 'toggle-status': toggleStatus(id, value); break;
            case 'toggle-wa':   toggleWaAccess(id, parseInt(value, 10)); break;
            case 'edit':        openEditModal(id); break;
            case 'delete':      deleteUser(id); break;
        }
    });
});

// ─── Filter bar ───────────────────────────────────────────────
function initFilterBar() {
    const filterBar = document.getElementById('adminFilterBar');
    if (!filterBar) return;
    filterBar.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter || 'all';
            setFilter(filter);
        });
    });
}

function setFilter(filter) {
    CURRENT_FILTER = filter;
    const filterBar = document.getElementById('adminFilterBar');
    if (filterBar) {
        filterBar.querySelectorAll('.filter-btn').forEach(btn => {
            if (btn.dataset.filter === filter) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
    renderUsers();
}

function updateFilterBadges() {
    const all = ALL_USERS.length;
    const pending = ALL_USERS.filter(u => u.status === 'pending').length;
    const active = ALL_USERS.filter(u => u.status === 'active').length;
    const suspended = ALL_USERS.filter(u => u.status === 'suspended').length;

    const elAll = document.getElementById('filterAllCount');
    const elPending = document.getElementById('filterPendingCount');
    const elActive = document.getElementById('filterActiveCount');
    const elSuspended = document.getElementById('filterSuspendedCount');

    if (elAll) elAll.textContent = all;
    if (elPending) elPending.textContent = pending;
    if (elActive) elActive.textContent = active;
    if (elSuspended) elSuspended.textContent = suspended;

    const banner = document.getElementById('approvalAlertBanner');
    const alertCount = document.getElementById('pendingAlertCount');
    const pendingFilterBtn = document.querySelector('.filter-btn-pending');

    if (pending > 0) {
        if (banner) banner.style.display = 'flex';
        if (alertCount) alertCount.textContent = pending;
        if (pendingFilterBtn) pendingFilterBtn.classList.add('has-pending');
    } else {
        if (banner) banner.style.display = 'none';
        if (pendingFilterBtn) pendingFilterBtn.classList.remove('has-pending');
    }
}

// ─── Auth gate ────────────────────────────────────────────────
async function checkAdminAuth() {
    try {
        if (!CURRENT_ACCESS_TOKEN) {
            const ok = await refreshSession();
            if (!ok) {
                window.location.href = '/login';
                return false;
            }
        }
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${CURRENT_ACCESS_TOKEN}` }
        });
        if (!res.ok) { window.location.href = '/login'; return false; }
        const json = await res.json();
        CURRENT_ADMIN = json.data;
        if (CURRENT_ADMIN.role !== 'admin') { window.location.href = '/app'; return false; }
        document.getElementById('adminWhoami').textContent = CURRENT_ADMIN.business_name || CURRENT_ADMIN.email;
        return true;
    } catch (e) {
        window.location.href = '/login';
        return false;
    }
}

async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
    window.location.href = '/login';
}

// ─── API helper ───────────────────────────────────────────────
async function api(path, options = {}) {
    let headers = { 'Content-Type': 'application/json', ...options.headers };
    if (CURRENT_ACCESS_TOKEN) {
        headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
    }
    
    let res = await fetch(path, { ...options, headers });
    
    if (res.status === 401) {
        const ok = await refreshSession();
        if (ok) {
            headers['Authorization'] = `Bearer ${CURRENT_ACCESS_TOKEN}`;
            res = await fetch(path, { ...options, headers });
        } else {
            window.location.href = '/login';
            throw new Error('Not authenticated');
        }
    }
    
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
        throw new Error(json.error || `Request failed (${res.status})`);
    }
    return json.data;
}

// ─── Platform stats ─────────────────────────────────────────
async function loadPlatformStats() {
    try {
        const stats = await api('/api/admin/stats');
        const grid = document.getElementById('platformStats');
        const cards = [
            { icon: 'users', color: 'a', num: stats.totalUsers, lbl: 'Total Accounts' },
            { icon: 'clock', color: 'd', num: stats.pendingUsers || 0, lbl: 'Pending Approval' },
            { icon: 'check-circle', color: 'b', num: stats.activeUsers, lbl: 'Active' },
            { icon: 'x-circle', color: 'e', num: stats.suspendedUsers, lbl: 'Suspended' },
            { icon: 'message-circle', color: 'c', num: stats.totalMessages, lbl: 'Total Messages' },
            { icon: 'trending-up', color: 'd', num: stats.totalDeals, lbl: 'CRM Deals' }
        ];
        grid.innerHTML = cards.map(c => `
            <div class="admin-stat-card">
                <span class="admin-stat-icon stat-${c.color}">${Icon(c.icon)}</span>
                <span>
                    <span class="num">${c.num.toLocaleString()}</span>
                    <span class="lbl">${c.lbl}</span>
                </span>
            </div>
        `).join('');
    } catch (err) {
        showToast(err.message || 'Failed to load platform stats', 'error');
    }
}

// ─── Users table ──────────────────────────────────────────────
async function loadUsers() {
    try {
        ALL_USERS = await api('/api/admin/users');
        updateFilterBadges();
        renderUsers();
    } catch (err) {
        showToast(err.message || 'Failed to load accounts', 'error');
    }
}

function renderUsers() {
    const q = (document.getElementById('userSearch').value || '').trim().toLowerCase();
    const tbody = document.getElementById('usersBody');
    const empty = document.getElementById('usersEmpty');

    const filtered = ALL_USERS.filter(u => {
        const matchesQuery = !q || (u.business_name || '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
        if (!matchesQuery) return false;
        if (CURRENT_FILTER === 'all') return true;
        return u.status === CURRENT_FILTER;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = filtered.map(u => {
        const initials = (u.business_name || u.email).slice(0, 2).toUpperCase();
        let statusPill = '';
        if (u.status === 'active') {
            statusPill = `<span class="pill pill-active">${Icon('check-circle')} Active</span>`;
        } else if (u.status === 'pending') {
            statusPill = `<span class="pill pill-pending">${Icon('clock')} Pending Approval</span>`;
        } else if (u.status === 'rejected') {
            statusPill = `<span class="pill pill-rejected">${Icon('x-circle')} Rejected</span>`;
        } else {
            statusPill = `<span class="pill pill-suspended">${Icon('pause')} Suspended</span>`;
        }

        const rolePill = u.role === 'admin'
            ? `<span class="pill pill-admin">${Icon('crown')} Admin</span>`
            : `<span class="pill pill-user">${Icon('user')} User</span>`;
        const wa = u.whatsapp || { connected: false, phone: null };
        const waLabel = wa.connected ? `Connected${wa.phone ? ' · ' + wa.phone : ''}` : (wa.started ? 'Connecting…' : 'Not connected');
        const s = u.stats || {};
        const isSelf = CURRENT_ADMIN && u.id === CURRENT_ADMIN.id;

        const isPending = u.status === 'pending';

        // ── WA Access cell ──
        // Uses data-action / data-id / data-value instead of onclick="" (CSP)
        const waAccessCell = u.role === 'admin'
            ? `<span class="pill pill-admin" title="Admins always have access">${Icon('crown')} Always</span>`
            : `<button class="btn btn-tiny" style="background:${u.wa_enabled ? 'var(--color-success)' : 'var(--color-error)'};color:#fff;font-size:.75rem;"
                 data-action="toggle-wa" data-id="${u.id}" data-value="${u.wa_enabled ? 0 : 1}"
                 type="button" title="${u.wa_enabled ? 'Revoke WhatsApp access' : 'Grant WhatsApp access'}">
                 ${u.wa_enabled ? Icon('check-circle') + ' Enabled' : Icon('x-circle') + ' Disabled'}
               </button>`;

        // ── Action buttons ──
        const approveRejectBtns = isPending ? `
            <button class="btn btn-success-sm" data-action="approve" data-id="${u.id}" type="button" title="Approve Account">${Icon('check')} Approve</button>
            <button class="btn btn-warning-sm" data-action="reject"  data-id="${u.id}" type="button" title="Reject Account">${Icon('x')} Reject</button>
        ` : '';

        const toggleStatusBtn = (!isPending && !isSelf)
            ? `<button class="btn btn-tiny" data-action="toggle-status" data-id="${u.id}" data-value="${u.status === 'active' ? 'suspended' : 'active'}" type="button" title="${u.status === 'active' ? 'Suspend' : 'Activate'}">
                 ${Icon(u.status === 'active' ? 'pause' : 'play')} <span class="btn-label-mobile">${u.status === 'active' ? 'Suspend' : 'Activate'}</span>
               </button>`
            : '';

        const deleteBtn = !isSelf
            ? `<button class="btn btn-danger-sm" data-action="delete" data-id="${u.id}" type="button" title="Delete">${Icon('trash-2')} <span class="btn-label-mobile">Delete</span></button>`
            : '';

        return `
            <tr>
                <td data-label="Account">
                    <div class="user-cell">
                        <span class="biz">${escapeHtml(u.business_name || '(' + initials + ')')}</span>
                        <span class="mail">${escapeHtml(u.email)}</span>
                    </div>
                </td>
                <td data-label="Role">${rolePill}</td>
                <td data-label="Status">${statusPill}</td>
                <td data-label="WhatsApp">
                    <span class="wa-dot ${wa.connected ? 'connected' : ''}">${escapeHtml(waLabel)}</span>
                </td>
                <td data-label="WA Access" style="text-align:center">${waAccessCell}</td>
                <td data-label="Usage">
                    <div style="font-size:.8rem;line-height:1.5">
                        <div>${s.messagesThisMonth || 0} msgs this month</div>
                        <div style="color:var(--text-secondary)">${s.contacts || 0} contacts · ${s.leads || 0} leads</div>
                    </div>
                </td>
                <td data-label="Plan">
                    <div style="font-size:.8rem;line-height:1.5">
                        <div>${escapeHtml(u.plan || 'free')}</div>
                        <div style="color:var(--text-secondary)">${u.message_limit ? u.message_limit + ' msgs/mo' : 'Unlimited msgs'} · ${u.rule_limit ? u.rule_limit + ' rules' : 'Unlimited rules'}</div>
                    </div>
                </td>
                <td data-label="Joined" style="color:var(--text-secondary);font-size:.8rem;white-space:nowrap">${formatDate(u.created_at)}</td>
                <td data-label="Actions">
                    <div class="row-actions">
                        ${approveRejectBtns}
                        <button class="btn btn-tiny" data-action="edit" data-id="${u.id}" type="button" title="Edit">${Icon('settings')} <span class="btn-label-mobile">Edit</span></button>
                        ${toggleStatusBtn}
                        ${deleteBtn}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Approve account ──────────────────────────────────────────
async function approveUser(id) {
    const user = ALL_USERS.find(u => u.id === id);
    const name = user ? (user.business_name || user.email) : 'this user';
    try {
        await api(`/api/admin/users/${id}/approve`, { method: 'POST' });
        showToast(`Account approved for ${name} ✅ User can now log in.`, 'success');
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not approve account', 'error');
    }
}

// ─── Reject account ───────────────────────────────────────────
async function rejectUser(id) {
    const user = ALL_USERS.find(u => u.id === id);
    const name = user ? (user.business_name || user.email) : 'this user';
    if (!confirm(`Decline registration request for "${name}"? They will not be permitted to log in.`)) return;
    try {
        await api(`/api/admin/users/${id}/reject`, { method: 'POST' });
        showToast(`Registration request declined for ${name}`, 'success');
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not reject account', 'error');
    }
}

// ─── Suspend / activate ────────────────────────────────────────
async function toggleStatus(id, newStatus) {
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
        showToast(newStatus === 'active' ? 'Account activated' : 'Account suspended', 'success');
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not update account', 'error');
    }
}

// ─── Grant / revoke WhatsApp access ────────────────────────────
async function toggleWaAccess(id, newValue) {
    const enabling = newValue === 1;
    const label = enabling ? 'Grant WhatsApp access to this user?' : 'Revoke WhatsApp access? Their active connection will be disconnected.';
    if (!confirm(label)) return;
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ wa_enabled: newValue }) });
        showToast(enabling ? 'WhatsApp access granted ✅' : 'WhatsApp access revoked', 'success');
        await loadUsers();
    } catch (err) {
        showToast(err.message || 'Could not update WhatsApp access', 'error');
    }
}

// ─── Delete ───────────────────────────────────────────────────
async function deleteUser(id) {
    const user = ALL_USERS.find(u => u.id === id);
    if (!confirm(`Permanently delete "${user ? (user.business_name || user.email) : 'this account'}" and all of its data? This cannot be undone.`)) return;
    try {
        await api(`/api/admin/users/${id}`, { method: 'DELETE' });
        showToast('Account deleted', 'success');
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not delete account', 'error');
    }
}

// ─── Edit modal ───────────────────────────────────────────────
function openEditModal(id) {
    const u = ALL_USERS.find(x => x.id === id);
    if (!u) return;
    document.getElementById('editUserId').value = u.id;
    document.getElementById('editBusinessName').value = u.business_name || '';
    document.getElementById('editOwnerName').value = u.owner_name || '';
    document.getElementById('editStatus').value = u.status || 'active';
    document.getElementById('editRole').value = u.role;
    document.getElementById('editPlan').value = u.plan || 'free';
    document.getElementById('editMessageLimit').value = u.message_limit || 0;
    const backdrop = document.getElementById('editModalBackdrop');
    if (backdrop) {
        backdrop.style.display = 'flex';
        backdrop.classList.add('show');
        if (typeof hydrateIcons === 'function') hydrateIcons(backdrop);
    }
}

function closeEditModal() {
    const backdrop = document.getElementById('editModalBackdrop');
    if (backdrop) {
        backdrop.style.display = 'none';
        backdrop.classList.remove('show');
    }
}

async function saveEditModal() {
    const id = document.getElementById('editUserId').value;
    const fields = {
        business_name: document.getElementById('editBusinessName').value.trim(),
        owner_name: document.getElementById('editOwnerName').value.trim(),
        status: document.getElementById('editStatus').value,
        role: document.getElementById('editRole').value,
        plan: document.getElementById('editPlan').value.trim() || 'free',
        message_limit: parseInt(document.getElementById('editMessageLimit').value, 10) || 0,
        rule_limit: parseInt(document.getElementById('editRuleLimit').value, 10) || 0
    };
    try {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
        showToast('Account updated', 'success');
        closeEditModal();
        await Promise.all([loadUsers(), loadPlatformStats()]);
    } catch (err) {
        showToast(err.message || 'Could not save changes', 'error');
    }
}

// ─── Toasts ───────────────────────────────────────────────────
function showToast(message, type = 'success') {
    const host = document.getElementById('toastHost');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const iconName = type === 'success' ? 'check-circle' : 'x-circle';
    el.innerHTML = `${Icon(iconName)}<span>${escapeHtml(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3800);
}
