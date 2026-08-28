CREATE TABLE `scheduled_task` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`mode` text NOT NULL,
	`run_id` text,
	`due_at` integer NOT NULL,
	`prompt` text NOT NULL,
	`callback_message_id` text,
	`fired_at` integer,
	`canceled_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_scheduled_task_agent_id_collab_agent_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `collab_agent`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `scheduled_task_due_idx` ON `scheduled_task` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `scheduled_task_agent_idx` ON `scheduled_task` (`agent_id`,`status`);