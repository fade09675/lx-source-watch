-- 代理订阅补充字段：区分 URL 订阅与文件/快照，保存自定义请求头。
ALTER TABLE proxy_subscriptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'url';
ALTER TABLE proxy_subscriptions ADD COLUMN headers TEXT NOT NULL DEFAULT '';
