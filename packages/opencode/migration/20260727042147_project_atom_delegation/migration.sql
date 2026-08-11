ALTER TABLE `collab_agent` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `collab_message` ADD `run_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `collab_msg_terminal_run_idx` ON `collab_message` (`recipient_agent_id`,`sender_agent_id`,`run_id`) WHERE "collab_message"."run_id" is not null and "collab_message"."kind" in ('child_done', 'child_failed');
