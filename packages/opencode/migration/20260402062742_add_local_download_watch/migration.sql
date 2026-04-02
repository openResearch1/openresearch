CREATE TABLE `local_download_watch` (
	`watch_id` text PRIMARY KEY,
	`exp_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`resource_name` text NOT NULL,
	`resource_type` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`local_resource_root` text,
	`local_path` text,
	`pid` integer,
	`log_path` text,
	`status_path` text,
	`source_selection` text,
	`method` text,
	`error_message` text,
	`last_polled_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_local_download_watch_exp_id_experiment_exp_id_fk` FOREIGN KEY (`exp_id`) REFERENCES `experiment`(`exp_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `local_download_watch_exp_idx` ON `local_download_watch` (`exp_id`);--> statement-breakpoint
CREATE INDEX `local_download_watch_status_idx` ON `local_download_watch` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_download_watch_exp_resource_idx` ON `local_download_watch` (`exp_id`,`resource_key`);