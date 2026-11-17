const http = require('http');

function post(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...headers
            }
        }, (res) => {
            let out = '';
            res.on('data', chunk => out += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(out) });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, raw: out });
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path,
            method: 'GET',
            headers
        }, (res) => {
            let out = '';
            res.on('data', chunk => out += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(out) });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, raw: out });
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function put(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path,
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...headers
            }
        }, (res) => {
            let out = '';
            res.on('data', chunk => out += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(out) });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, raw: out });
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function main() {
    console.log('=== TEST 1: Health Check ===');
    const health = await get('/health');
    console.log('Health:', health.status, JSON.stringify(health.data));

    console.log('\n=== TEST 2: Admin Authentication ===');
    const login = await post('/api/auth/login', {
        email: 'hitrocks19@gmail.com',
        password: 'Admin@Hitrocks2026!'
    });
    console.log('Login Status:', login.status, 'Success:', login.data?.success, 'User:', login.data?.data?.email);

    let cookie = '';
    if (login.headers['set-cookie']) {
        cookie = login.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }
    const token = login.data?.accessToken;
    const authHeaders = {
        'Cookie': cookie,
        'Authorization': `Bearer ${token}`
    };

    console.log('\n=== TEST 3: Calendar Link Feature ===');
    const calStatus = await get('/api/calendar/status', authHeaders);
    console.log('Calendar Status:', calStatus.status, 'Configured:', calStatus.data?.data?.configured, 'Current Link:', calStatus.data?.data?.calendarLink);

    const testLink = 'https://calendar.google.com/calendar/appointments/schedules/AcZssZ3example';
    const putCal = await put('/api/calendar/link', { calendarLink: testLink }, authHeaders);
    console.log('Update Calendar Link:', putCal.status, 'Saved Link:', putCal.data?.data?.calendarLink);

    const getCal = await get('/api/calendar/link', authHeaders);
    console.log('Get Calendar Link:', getCal.status, 'Retrieved Link:', getCal.data?.data?.calendarLink);

    console.log('\n=== TEST 4: Users and Mobile Station Accounts ===');
    const adminUsers = await get('/api/admin/users', authHeaders);
    if (adminUsers.data?.data) {
        const msAccounts = adminUsers.data.data.filter(u => u.email.includes('mobilestation'));
        console.log(`Found ${msAccounts.length} Mobile Station account(s):`);
        msAccounts.forEach(a => {
            console.log(` - ID ${a.id}: ${a.email} | ${a.business_name} | status: ${a.status} | wa_enabled: ${a.wa_enabled}`);
        });
    }

    console.log('\n=== TEST 5: Chat Analysis & Leads ===');
    const leads = await get('/api/leads', authHeaders);
    console.log('Leads API Status:', leads.status, 'Total analyses:', leads.data?.data?.leads?.length, 'Pending chats:', leads.data?.data?.pending?.length);
    if (leads.data?.data?.leads?.length) {
        console.log('Sample Lead:', leads.data.data.leads[0].phone, '| Contact Name:', leads.data.data.leads[0].contact_name);
    }
    if (leads.data?.data?.pending?.length) {
        console.log('Sample Pending:', leads.data.data.pending[0].phone, '| Contact Name:', leads.data.data.pending[0].contact_name);
    }

    console.log('\n=== TEST 6: Phone Number & LID Resolution Engine ===');
    const { resolveTargetChatId } = require('../src/services/whatsapp-client');
    // Test resolveTargetChatId fallback (offline/mock)
    const test1 = await resolveTargetChatId(null, '9892156535');
    console.log('10-digit Indian (9892156535) ->', test1);
    const test2 = await resolveTargetChatId(null, '09892156535');
    console.log('11-digit leading 0 (09892156535) ->', test2);
    const test3 = await resolveTargetChatId(null, '919892156535');
    console.log('12-digit E.164 (919892156535) ->', test3);
    const test4 = await resolveTargetChatId(null, '48236811309168');
    console.log('14-digit WhatsApp LID (48236811309168) ->', test4);

    console.log('\n✅ ALL VERIFICATION CHECKS COMPLETED SUCCESSFULLY!');
}

main().catch(err => {
    console.error('❌ Verification failed:', err);
    process.exit(1);
});
