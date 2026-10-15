-- 012_products_image.sql: Add image_path to products table for product catalogue images

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'image_path'
    ) THEN
        ALTER TABLE products ADD COLUMN image_path TEXT DEFAULT '';
    END IF;
END $$;
