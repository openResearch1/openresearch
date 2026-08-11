CREATE TABLE `research_deletion` (
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `research_deletion_pk` PRIMARY KEY(`kind`, `entity_id`)
);
--> statement-breakpoint
CREATE TABLE `session_deletion` (
	`session_id` text PRIMARY KEY,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_deletion_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_ownership` (
	`session_id` text PRIMARY KEY,
	`owner` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_ownership_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `collab_message` ADD `claim_id` text;--> statement-breakpoint
ALTER TABLE `remote_task_listener` ADD `run_id` text;