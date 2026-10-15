-- 001_initial_schema.sql: Initial relational schema for multi-tenant WhatsApp automation

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    business_name TEXT DEFAULT '',
    owner_name TEXT DEFAULT '',
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('active', 'suspended', 'pending', 'rejected')),
    plan TEXT DEFAULT 'free',
    message_limit INTEGER DEFAULT 0,
    rule_limit INTEGER DEFAULT 0,
    wa_enabled INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    name TEXT DEFAULT '',
    label TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    last_outreach_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_contacts_user_phone UNIQUE(user_id, phone)
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wa_message_id TEXT,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
    message_type TEXT DEFAULT 'text',
    body TEXT DEFAULT '',
    status TEXT DEFAULT 'sent',
    template_name TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chatbot_rules (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_keyword TEXT NOT NULL,
    match_type TEXT DEFAULT 'contains' CHECK(match_type IN ('exact', 'contains', 'startswith', 'regex')),
    response_text TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    body TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'cancelled', 'unknown')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price TEXT DEFAULT '',
    category TEXT DEFAULT '',
    url TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_deals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    stage TEXT DEFAULT 'new' CHECK(stage IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
    deal_value NUMERIC DEFAULT 0,
    product_interest TEXT DEFAULT '',
    source TEXT DEFAULT 'whatsapp',
    notes TEXT DEFAULT '',
    next_followup_at TIMESTAMPTZ,
    ai_suggested_stage TEXT DEFAULT '',
    ai_estimated_value NUMERIC DEFAULT 0,
    stage_changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_crm_deals_user_phone UNIQUE(user_id, phone)
);

CREATE TABLE IF NOT EXISTS crm_activities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    type TEXT DEFAULT 'note',
    content TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lead_analysis (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    interest_status TEXT DEFAULT 'unclear' CHECK(interest_status IN ('interested', 'not_interested', 'neutral', 'unclear')),
    interest_score INTEGER DEFAULT 0,
    sentiment TEXT DEFAULT 'neutral',
    issue_category TEXT DEFAULT '',
    issues TEXT DEFAULT '[]',
    priority TEXT DEFAULT 'low' CHECK(priority IN ('high', 'medium', 'low')),
    priority_reason TEXT DEFAULT '',
    next_action TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    last_analyzed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_lead_analysis_user_phone UNIQUE(user_id, phone)
);

CREATE TABLE IF NOT EXISTS google_calendar_accounts (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    scope TEXT,
    token_type TEXT,
    expiry_date BIGINT,
    calendar_id TEXT DEFAULT 'primary',
    check_availability INTEGER DEFAULT 0,
    connected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_sync_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS google_calendar_synced_events (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    scheduled_message_id INTEGER REFERENCES scheduled_messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, event_id)
);

CREATE TABLE IF NOT EXISTS availability_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    working_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
    start_time TEXT NOT NULL DEFAULT '09:00',
    end_time TEXT NOT NULL DEFAULT '18:00',
    slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
    buffer_minutes INTEGER NOT NULL DEFAULT 0,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    booking_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    start_at TIMESTAMPTZ NOT NULL,
    end_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'cancelled')),
    source TEXT NOT NULL DEFAULT 'chatbot' CHECK(source IN ('chatbot', 'dashboard')),
    notes TEXT DEFAULT '',
    calendar_event_id TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
