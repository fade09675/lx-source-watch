-- 音源注册表：Web 管理的音源清单，探测时从公开接口读取。
CREATE TABLE IF NOT EXISTS source_registry (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '在线',
  storage TEXT NOT NULL DEFAULT 'remote',
  url TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  homepage TEXT NOT NULL DEFAULT '',
  mirrors TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  trusted INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_registry_enabled ON source_registry(enabled, sort_order);

INSERT INTO source_registry
  (id, title, category, storage, url, path, homepage, mirrors, enabled, trusted, notes, sort_order, created_at, updated_at)
VALUES
('pdone-changqing', '长青', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/changqing/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，上游后端波动，恢复后自动变绿', '0', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-flower', '花花', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/flower/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，上游取链 404', '1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-grass', '小草', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/grass/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，上游取链 404', '2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-huanyin', '幻音', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huanyin/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，上游域名失效', '3', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-huibq', '汇帮', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，脚本返回 unknow error', '4', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-ikun', 'IKUN', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/ikun/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，上游域名失效', '5', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-juhe', '聚合', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/juhe/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '老目录，初始化超时', '6', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-qdy', '千大音', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/qdy/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '', '7', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-sixyin', '六音', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/sixyin/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '', '8', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-xinghai', '星海', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/xinghai/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '', '9', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-feichangdao', '非常刀', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/feichangdao/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '10', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-fish', '鱼音', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/fish/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '11', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-helloworld', 'HelloWorld', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/helloworld/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '12', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-hyw', 'HYW', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/hyw/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '13', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-jiexiang', '杰翔', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/jiexiang/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '14', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-qingliang', '轻量', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/qingliang/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录，实测 4/4', '15', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-suyin', '溯音', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/suyin/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '16', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-xinglan', '星澜', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/xinglan/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录，实测 4/6', '17', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('pdone-yuningxi', '玉宁熙', '在线', 'remote', 'https://raw.githubusercontent.com/pdone/lx-music-source/main/yuningxi/latest.js', '', 'https://github.com/pdone/lx-music-source', '[]', '1', '0', '新增目录', '18', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
