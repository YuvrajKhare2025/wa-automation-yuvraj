/**
 * scripts/provision-mobile-stations.js
 *
 * Ensures both Mobile Station accounts exist and are fully enabled:
 * 1. mobile station kalher (mobilestationkalher@gmail.com)
 * 2. mobile station 01 (mobilestation01@gmail.com)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/whatsapp_automation'
});

async function main() {
    console.log('Connecting to PostgreSQL database...');
    const client = await pool.connect();
    try {
        const defaultPassword = process.env.MOBILE_STATION_PASSWORD || 'MobileStation@2026!';
        const salt = await bcrypt.genSalt(12);
        const hash = await bcrypt.hash(defaultPassword, salt);

        console.log('--- Checking Account 1: Mobile Station Kalher ---');
        let res1 = await client.query('SELECT id, email, status, wa_enabled, business_name FROM users WHERE email = $1', ['mobilestationkalher@gmail.com']);
        if (res1.rows.length === 0) {
            console.log('Creating mobilestationkalher@gmail.com...');
            await client.query(`
                INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan, message_limit, rule_limit, wa_enabled)
                VALUES ($1, $2, 'Mobile Station Kalher', 'Mobile Station', 'user', 'active', '4999/- Month', 5000, 10, 1)
            `, ['mobilestationkalher@gmail.com', hash]);
            console.log('Created mobilestationkalher@gmail.com with wa_enabled=1');
        } else {
            console.log(`Found account 1 (id: ${res1.rows[0].id}). Updating status='active', wa_enabled=1, business_name='Mobile Station Kalher'...`);
            await client.query(`
                UPDATE users
                SET status = 'active',
                    wa_enabled = 1,
                    business_name = 'Mobile Station Kalher'
                WHERE id = $1
            `, [res1.rows[0].id]);
            console.log('Account 1 updated successfully.');
        }

        console.log('--- Checking Account 2: Mobile Station 01 ---');
        let res2 = await client.query('SELECT id, email, status, wa_enabled, business_name FROM users WHERE email = $1', ['mobilestation01@gmail.com']);
        if (res2.rows.length === 0) {
            console.log('Creating mobilestation01@gmail.com...');
            await client.query(`
                INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan, message_limit, rule_limit, wa_enabled)
                VALUES ($1, $2, 'Mobile Station 01', 'Mobile Station 01', 'user', 'active', '4999/- Month', 5000, 10, 1)
            `, ['mobilestation01@gmail.com', hash]);
            console.log('Created mobilestation01@gmail.com with wa_enabled=1, plan=4999/- Month');
        } else {
            console.log(`Found account 2 (id: ${res2.rows[0].id}). Ensuring status='active', wa_enabled=1...`);
            await client.query(`
                UPDATE users
                SET status = 'active',
                    wa_enabled = 1,
                    business_name = 'Mobile Station 01'
                WHERE id = $1
            `, [res2.rows[0].id]);
            console.log('Account 2 updated successfully.');
        }

        const summary = await client.query(`
            SELECT id, email, business_name, role, status, plan, wa_enabled
            FROM users
            WHERE email IN ('mobilestationkalher@gmail.com', 'mobilestation01@gmail.com')
        `);
        console.log('\n--- Final Mobile Station Accounts Status ---');
        console.table(summary.rows);
        console.log(`\nDefault password for freshly provisioned accounts: ${defaultPassword}`);
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => {
    console.error('Provisioning failed:', err.message);
    process.exit(1);
});
