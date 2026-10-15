document.addEventListener('DOMContentLoaded', async () => {
    if (typeof hydrateIcons === 'function') hydrateIcons();

    // If already logged in (has a valid refresh cookie), skip straight to the app
    try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
            window.location.href = '/app';
            return;
        }
    } catch (e) { /* not logged in — show the form as normal */ }

    initPasswordToggle();
    initLoginForm();
    initSignupForm();
});

function initPasswordToggle() {
    const btn = document.getElementById('pwToggle');
    const input = document.getElementById('password');
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.innerHTML = Icon(showing ? 'eye' : 'eye-off');
    });
}

function showFormError(message) {
    const box = document.getElementById('formError');
    const text = document.getElementById('formErrorText');
    if (!box || !text) return;
    text.textContent = message;
    box.classList.add('show');
}

function hideFormError() {
    const box = document.getElementById('formError');
    if (box) box.classList.remove('show');
}

function setSubmitting(btn, isSubmitting, label) {
    if (!btn) return;
    btn.disabled = isSubmitting;
    if (isSubmitting) {
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = `<span data-icon="loader-2" data-icon-class="icon-spin" aria-hidden="true"></span> ${label || 'Please wait…'}`;
        if (typeof hydrateIcons === 'function') hydrateIcons(btn);
    } else if (btn.dataset.originalHtml) {
        btn.innerHTML = btn.dataset.originalHtml;
    }
}

function initLoginForm() {
    const form = document.getElementById('loginForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideFormError();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const btn = document.getElementById('submitBtn');
        setSubmitting(btn, true, 'Logging in…');

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email, password })
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Could not log in.');
            }
            if (json.data && json.data.role === 'admin') {
                window.location.href = '/admin';
            } else {
                window.location.href = '/app';
            }
        } catch (err) {
            showFormError(err.message || 'Could not log in. Please try again.');
            setSubmitting(btn, false);
        }
    });
}

function initSignupForm() {
    const form = document.getElementById('signupForm');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideFormError();
        const businessName = document.getElementById('businessName').value.trim();
        const ownerName = document.getElementById('ownerName').value.trim();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const btn = document.getElementById('submitBtn');

        if (password.length < 8) {
            showFormError('Password must be at least 8 characters.');
            return;
        }

        setSubmitting(btn, true, 'Creating your account…');

        try {
            const res = await fetch('/api/auth/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ businessName, ownerName, email, password })
            });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Could not create your account.');
            }
            if (json.pendingApproval) {
                const section = document.getElementById('signupFormSection');
                const notice = document.getElementById('pendingApprovalNotice');
                const emailText = document.getElementById('registeredEmailText');
                if (section && notice) {
                    section.style.display = 'none';
                    if (emailText) emailText.textContent = email;
                    notice.style.display = 'block';
                    if (typeof hydrateIcons === 'function') hydrateIcons(notice);
                    return;
                }
            }
            window.location.href = '/app';
        } catch (err) {
            showFormError(err.message || 'Could not create your account. Please try again.');
            setSubmitting(btn, false);
        }
    });
}
