-- Instagram, through the official Instagram API (Instagram Login).
--
-- The homepage "Real People. Real Style." section shows the brand's own
-- Instagram reels and posts. Until now an editor had to paste a link, pick a
-- cover picture and type a handle for every card. With the account connected,
-- the posts, their pictures and their links come from Instagram itself.
--
--   instagram_connections — one per company: which Instagram professional
--     account is connected and its access token. The token is a credential, so
--     it is stored ENCRYPTED (AES-256-GCM, key only in the server environment:
--     PROVIDER_SECRET_ENCRYPTION_KEY) and never returned by any API. Instagram
--     tokens last 60 days; the server renews them before they run out, which
--     is why it has to be stored rather than living in the environment.
--
--   instagram_media — the account's posts as last seen by the sync. Instagram
--     picture links expire within days, so each post's cover is copied into our
--     own Media Library (cover_media_id) and served from there. A post that is
--     no longer on Instagram is marked REMOVED and stops showing; nothing is
--     deleted, so a homepage that picked it degrades instead of breaking.
--
-- Forward-only. MySQL 8.x.

CREATE TABLE instagram_connections (
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,

  ig_user_id VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  account_type VARCHAR(32) NULL,

  -- iv:tag:ciphertext (base64). Never logged, never sent to a client.
  token_ciphertext TEXT NOT NULL,
  -- Known once Instagram has told us (a renewal returns expires_in). NULL for
  -- a freshly pasted token, whose age we cannot see.
  token_expires_at DATETIME(3) NULL,
  -- Instagram only renews a token that is at least 24 hours old.
  token_refresh_after DATETIME(3) NOT NULL,
  token_refreshed_at DATETIME(3) NULL,

  -- CONNECTED: working. AUTH_FAILED: Instagram rejected the token (revoked,
  -- expired, password changed) — an admin must reconnect.
  status VARCHAR(16) NOT NULL DEFAULT 'CONNECTED',
  last_synced_at DATETIME(3) NULL,
  last_sync_error VARCHAR(255) NULL,

  connected_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (brand_id),
  CONSTRAINT chk_instagram_connections_status CHECK (status IN ('CONNECTED', 'AUTH_FAILED')),
  CONSTRAINT fk_instagram_connections_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT,
  CONSTRAINT fk_instagram_connections_staff FOREIGN KEY (connected_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE instagram_media (
  id CHAR(36) NOT NULL,
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,

  ig_media_id VARCHAR(64) NOT NULL,
  -- IMAGE | VIDEO | CAROUSEL_ALBUM
  media_type VARCHAR(24) NOT NULL,
  -- FEED | REELS | STORY | AD
  media_product_type VARCHAR(24) NULL,
  shortcode VARCHAR(64) NULL,
  permalink VARCHAR(500) NOT NULL,
  caption TEXT NULL,
  posted_at DATETIME(3) NULL,

  -- Our own copy of the post's picture (Instagram's links expire).
  cover_media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,

  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uk_instagram_media_post (brand_id, ig_media_id),
  -- The homepage reads "this company's live posts, newest first".
  KEY idx_instagram_media_live (brand_id, status, posted_at),
  KEY idx_instagram_media_cover (cover_media_id),
  CONSTRAINT chk_instagram_media_status CHECK (status IN ('ACTIVE', 'REMOVED')),
  CONSTRAINT fk_instagram_media_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT,
  -- RESTRICT, like hero banners: a cover in use cannot be deleted out from under a post.
  CONSTRAINT fk_instagram_media_cover FOREIGN KEY (cover_media_id) REFERENCES media(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
