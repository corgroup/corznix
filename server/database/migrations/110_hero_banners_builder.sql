-- Hero slides builder: art direction and timing per slide.
--
-- 086 shipped one asset per banner, cropped for every screen, the copy always
-- in the bottom-left corner on a fixed dark shade, and every picture slide on
-- a fixed 6-second timer. A tall phone crop of a wide picture often cuts the
-- subject out, and the text often sits on the busiest part of the picture, so
-- each slide now carries:
--   mobile_media_id        an optional picture or video for phones (empty:
--                          the desktop one, cropped);
--   text_position          where the copy sits on tablets and desktops;
--   mobile_text_position   where it sits on phones;
--   text_theme             LIGHT (white text on a dark shade) or DARK (dark
--                          text on a light shade);
--   overlay                how strong that shade is, 0-90 (%);
--   duration_seconds       how long a picture slide stays before the next
--                          (a video slide plays to its end).
--
-- The defaults are exactly the look 086 rendered (bottom-left, white text,
-- a 55% shade, 6 seconds), so existing slides do not change. Forward-only,
-- non-destructive. MySQL 8.x.

ALTER TABLE hero_banners
  ADD COLUMN mobile_media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER media_id,
  ADD COLUMN text_position VARCHAR(16) NOT NULL DEFAULT 'BOTTOM_LEFT' AFTER alt_text,
  ADD COLUMN mobile_text_position VARCHAR(16) NOT NULL DEFAULT 'BOTTOM_LEFT' AFTER text_position,
  ADD COLUMN text_theme VARCHAR(8) NOT NULL DEFAULT 'LIGHT' AFTER mobile_text_position,
  ADD COLUMN overlay TINYINT UNSIGNED NOT NULL DEFAULT 55 AFTER text_theme,
  ADD COLUMN duration_seconds TINYINT UNSIGNED NOT NULL DEFAULT 6 AFTER overlay,
  ADD KEY idx_hero_banners_mobile_media (mobile_media_id),
  -- Same rule as media_id: a picture in use cannot be deleted from under a slide.
  ADD CONSTRAINT fk_hero_banners_mobile_media FOREIGN KEY (mobile_media_id) REFERENCES media(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_hero_banners_text_position CHECK (text_position IN
    ('TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'MIDDLE_LEFT', 'MIDDLE_CENTER', 'MIDDLE_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT')),
  ADD CONSTRAINT chk_hero_banners_mobile_text_position CHECK (mobile_text_position IN
    ('TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'MIDDLE_LEFT', 'MIDDLE_CENTER', 'MIDDLE_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT')),
  ADD CONSTRAINT chk_hero_banners_text_theme CHECK (text_theme IN ('LIGHT', 'DARK')),
  ADD CONSTRAINT chk_hero_banners_overlay CHECK (overlay <= 90),
  ADD CONSTRAINT chk_hero_banners_duration CHECK (duration_seconds BETWEEN 3 AND 20);
