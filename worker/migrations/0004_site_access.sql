-- 記憶サイトの公開状態 (サーバーごと)。bot の /memory site が /v1/memory/access で書く。
--   off      誰にも見せない (メンバーにも。URL は存在しないのと同じ 404)
--   members  Discord でログインした、そのサーバーのメンバーだけ
--   public   誰でも (ログイン無し)
-- 行が無いサーバーは、wrangler.jsonc の MEMORY_ACCESS (既定 members) に従う。取り込み (/v1/memory/*) は off の間も受け付ける。
CREATE TABLE IF NOT EXISTS memory_site_access (
  guild_id   TEXT PRIMARY KEY,
  access     TEXT NOT NULL CHECK (access IN ('off', 'members', 'public')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
