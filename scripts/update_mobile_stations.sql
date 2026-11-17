UPDATE users SET business_name = 'Mobile Station Kalher' WHERE email = 'mobilestationkalher@gmail.com';

INSERT INTO users (email, password_hash, business_name, owner_name, role, status, plan, message_limit, rule_limit, wa_enabled)
VALUES ('mobilestation01@gmail.com', '$2a$12$UvmCRu8PTWKr4y/u/9/dMedkO22bs3SuHj127Tq32iEoOmqmTkxIq', 'Mobile Station 01', 'Mobile Station 01', 'user', 'active', '4999/- Month', 5000, 10, 1)
ON CONFLICT (email) DO UPDATE
SET status = 'active', wa_enabled = 1, business_name = 'Mobile Station 01', plan = '4999/- Month';

SELECT id, email, business_name, role, status, plan, wa_enabled FROM users;
