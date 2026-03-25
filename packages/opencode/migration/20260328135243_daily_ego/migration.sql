CREATE TABLE `experiment_watch` (
	`watch_id` text PRIMARY KEY,
	`exp_id` text NOT NULL,
	`wandb_entity` text NOT NULL,
	`wandb_project` text NOT NULL,
	`wandb_api_key` text NOT NULL,
	`wandb_run_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_polled_at` integer,
	`wandb_state` text,
	`error_message` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_experiment_watch_exp_id_experiment_exp_id_fk` FOREIGN KEY (`exp_id`) REFERENCES `experiment`(`exp_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `experiment_watch_exp_idx` ON `experiment_watch` (`exp_id`);--> statement-breakpoint
CREATE INDEX `experiment_watch_status_idx` ON `experiment_watch` (`status`);