-- 013_products_image_data.sql: Add image_data column for cross-instance image replication

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'image_data'
    ) THEN
        ALTER TABLE products ADD COLUMN image_data TEXT DEFAULT '';
    END IF;
END $$;
