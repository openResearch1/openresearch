CREATE TABLE `experiment_execution_watch` (
	`watch_id` text PRIMARY KEY,
	`exp_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stage` text DEFAULT 'planning' NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`wandb_entity` text,
	`wandb_project` text,
	`wandb_run_id` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_experiment_execution_watch_exp_id_experiment_exp_id_fk` FOREIGN KEY (`exp_id`) REFERENCES `experiment`(`exp_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `experiment_execution_watch_exp_idx` ON `experiment_execution_watch` (`exp_id`);--> statement-breakpoint
CREATE INDEX `experiment_execution_watch_status_idx` ON `experiment_execution_watch` (`status`);