ALTER TABLE `session` ADD `collab_peer` integer;
--> statement-breakpoint
-- Backfill existing collab child sessions (spawned peers have a
-- non-null collab_agent.parent_agent_id). Root collab agents stay
-- NULL so their session remains visible in the sidebar.
UPDATE `session` SET `collab_peer` = 1 WHERE `id` IN (
  SELECT `session_id` FROM `collab_agent` WHERE `parent_agent_id` IS NOT NULL
);