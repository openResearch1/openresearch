CREATE TABLE `collab_agent` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`parent_agent_id` text,
	`name` text NOT NULL,
	`project_id` text NOT NULL,
	`root_agent_id` text NOT NULL,
	`subagent_type` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`spec_json` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`active_children` integer DEFAULT 0 NOT NULL,
	`spawned_total` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_started` integer,
	`time_ended` integer,
	CONSTRAINT `fk_collab_agent_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_collab_agent_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `collab_message` (
	`id` text PRIMARY KEY,
	`recipient_agent_id` text NOT NULL,
	`sender_agent_id` text,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_consumed` integer,
	CONSTRAINT `fk_collab_message_recipient_agent_id_collab_agent_id_fk` FOREIGN KEY (`recipient_agent_id`) REFERENCES `collab_agent`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_runtime_environment` (
	`env_id` text PRIMARY KEY,
	`research_project_id` text NOT NULL,
	`remote_server_id` text NOT NULL,
	`runtime_exp_id` text NOT NULL,
	`env_key` text NOT NULL,
	`conda_env_name` text NOT NULL,
	`python_version` text,
	`spec` text,
	`fingerprint` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_verified_at` integer,
	`error_message` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_project_runtime_environment_research_project_id_research_project_research_project_id_fk` FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_runtime_environment_remote_server_id_remote_server_id_fk` FOREIGN KEY (`remote_server_id`) REFERENCES `remote_server`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_runtime_environment_runtime_exp_id_experiment_exp_id_fk` FOREIGN KEY (`runtime_exp_id`) REFERENCES `experiment`(`exp_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_runtime_resource` (
	`resource_id` text PRIMARY KEY,
	`research_project_id` text NOT NULL,
	`remote_server_id` text NOT NULL,
	`runtime_exp_id` text NOT NULL,
	`resource_key` text NOT NULL,
	`type` text NOT NULL,
	`source` text,
	`target_path` text NOT NULL,
	`verify` text,
	`fingerprint` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_verified_at` integer,
	`error_message` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_project_runtime_resource_research_project_id_research_project_research_project_id_fk` FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_runtime_resource_remote_server_id_remote_server_id_fk` FOREIGN KEY (`remote_server_id`) REFERENCES `remote_server`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_runtime_resource_runtime_exp_id_experiment_exp_id_fk` FOREIGN KEY (`runtime_exp_id`) REFERENCES `experiment`(`exp_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `remote_task` (
	`task_id` text PRIMARY KEY,
	`exp_id` text NOT NULL,
	`kind` text NOT NULL,
	`resource_key` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`server` text NOT NULL,
	`remote_root` text NOT NULL,
	`target_path` text,
	`screen_name` text NOT NULL,
	`command` text NOT NULL,
	`pid` integer,
	`log_path` text,
	`source_selection` text,
	`method` text,
	`error_message` text,
	`last_polled_at` integer,
	`stopped_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_remote_task_exp_id_experiment_exp_id_fk` FOREIGN KEY (`exp_id`) REFERENCES `experiment`(`exp_id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `experiment` ADD `kind` text DEFAULT 'experiment' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiment` ADD `runtime_key` text;--> statement-breakpoint
DROP INDEX IF EXISTS `local_download_watch_exp_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `local_download_watch_status_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `local_download_watch_exp_resource_idx`;--> statement-breakpoint
CREATE INDEX `collab_agent_session_idx` ON `collab_agent` (`session_id`);--> statement-breakpoint
CREATE INDEX `collab_agent_parent_idx` ON `collab_agent` (`parent_agent_id`);--> statement-breakpoint
CREATE INDEX `collab_agent_root_idx` ON `collab_agent` (`root_agent_id`);--> statement-breakpoint
CREATE INDEX `collab_agent_project_status_idx` ON `collab_agent` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `collab_msg_recipient_pending_idx` ON `collab_message` (`recipient_agent_id`,`status`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_runtime_key_idx` ON `experiment` (`runtime_key`);--> statement-breakpoint
CREATE INDEX `project_runtime_env_project_idx` ON `project_runtime_environment` (`research_project_id`);--> statement-breakpoint
CREATE INDEX `project_runtime_env_server_idx` ON `project_runtime_environment` (`remote_server_id`);--> statement-breakpoint
CREATE INDEX `project_runtime_env_runtime_exp_idx` ON `project_runtime_environment` (`runtime_exp_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_runtime_env_key_idx` ON `project_runtime_environment` (`research_project_id`,`remote_server_id`,`env_key`);--> statement-breakpoint
CREATE INDEX `project_runtime_resource_project_idx` ON `project_runtime_resource` (`research_project_id`);--> statement-breakpoint
CREATE INDEX `project_runtime_resource_server_idx` ON `project_runtime_resource` (`remote_server_id`);--> statement-breakpoint
CREATE INDEX `project_runtime_resource_runtime_exp_idx` ON `project_runtime_resource` (`runtime_exp_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_runtime_resource_key_idx` ON `project_runtime_resource` (`research_project_id`,`remote_server_id`,`resource_key`);--> statement-breakpoint
CREATE INDEX `remote_task_exp_idx` ON `remote_task` (`exp_id`);--> statement-breakpoint
CREATE INDEX `remote_task_status_idx` ON `remote_task` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_task_exp_kind_resource_idx` ON `remote_task` (`exp_id`,`kind`,`resource_key`);--> statement-breakpoint
DROP TABLE `local_download_watch`;