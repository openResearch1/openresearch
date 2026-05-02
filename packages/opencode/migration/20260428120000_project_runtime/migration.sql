ALTER TABLE `experiment` ADD `kind` text DEFAULT 'experiment' NOT NULL;
--> statement-breakpoint
ALTER TABLE `experiment` ADD `runtime_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `experiment_runtime_key_idx` ON `experiment` (`runtime_key`);
--> statement-breakpoint
CREATE TABLE `project_runtime_environment` (
	`env_id` text PRIMARY KEY NOT NULL,
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
	FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`remote_server_id`) REFERENCES `remote_server`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_exp_id`) REFERENCES `experiment`(`exp_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_runtime_env_project_idx` ON `project_runtime_environment` (`research_project_id`);
--> statement-breakpoint
CREATE INDEX `project_runtime_env_server_idx` ON `project_runtime_environment` (`remote_server_id`);
--> statement-breakpoint
CREATE INDEX `project_runtime_env_runtime_exp_idx` ON `project_runtime_environment` (`runtime_exp_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_runtime_env_key_idx` ON `project_runtime_environment` (`research_project_id`,`remote_server_id`,`env_key`);
--> statement-breakpoint
CREATE TABLE `project_runtime_resource` (
	`resource_id` text PRIMARY KEY NOT NULL,
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
	FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`remote_server_id`) REFERENCES `remote_server`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_exp_id`) REFERENCES `experiment`(`exp_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_runtime_resource_project_idx` ON `project_runtime_resource` (`research_project_id`);
--> statement-breakpoint
CREATE INDEX `project_runtime_resource_server_idx` ON `project_runtime_resource` (`remote_server_id`);
--> statement-breakpoint
CREATE INDEX `project_runtime_resource_runtime_exp_idx` ON `project_runtime_resource` (`runtime_exp_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_runtime_resource_key_idx` ON `project_runtime_resource` (`research_project_id`,`remote_server_id`,`resource_key`);
