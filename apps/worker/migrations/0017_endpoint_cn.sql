-- 4B：接入点（主地址/镜像）的国内连通性补测结果。
ALTER TABLE source_endpoints ADD COLUMN cn_ok INTEGER;
ALTER TABLE source_endpoints ADD COLUMN cn_ms INTEGER;
ALTER TABLE source_endpoints ADD COLUMN cn_ttfb_ms INTEGER;
ALTER TABLE source_endpoints ADD COLUMN cn_error TEXT;
ALTER TABLE source_endpoints ADD COLUMN cn_proxy TEXT;
ALTER TABLE source_endpoints ADD COLUMN cn_checked_at TEXT;
