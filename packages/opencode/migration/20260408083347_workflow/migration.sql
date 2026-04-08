CREATE TABLE `workflow_instance` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`template_id` text NOT NULL,
	`template_version` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`current_index` text NOT NULL,
	`steps_json` text NOT NULL,
	`context_json` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_workflow_instance_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `workflow_instance_session_idx` ON `workflow_instance` (`session_id`);--> statement-breakpoint
CREATE INDEX `workflow_instance_status_idx` ON `workflow_instance` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_instance_template_idx` ON `workflow_instance` (`template_id`);
