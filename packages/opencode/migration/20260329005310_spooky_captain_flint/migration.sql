PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_experiment` (
	`exp_id` text PRIMARY KEY,
	`research_project_id` text NOT NULL,
	`exp_session_id` text,
	`baseline_branch_name` text,
	`exp_branch_name` text,
	`exp_result_path` text,
	`atom_id` text,
	`exp_result_summary_path` text,
	`exp_plan_path` text,
	`remote_server_id` text,
	`code_path` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_experiment_research_project_id_research_project_research_project_id_fk` FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_experiment_exp_session_id_session_id_fk` FOREIGN KEY (`exp_session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_experiment_atom_id_atom_atom_id_fk` FOREIGN KEY (`atom_id`) REFERENCES `atom`(`atom_id`) ON DELETE SET NULL,
	CONSTRAINT `fk_experiment_remote_server_id_remote_server_id_fk` FOREIGN KEY (`remote_server_id`) REFERENCES `remote_server`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_experiment`(`exp_id`, `research_project_id`, `exp_session_id`, `baseline_branch_name`, `exp_branch_name`, `exp_result_path`, `atom_id`, `exp_result_summary_path`, `exp_plan_path`, `remote_server_id`, `code_path`, `status`, `started_at`, `finished_at`, `time_created`, `time_updated`) SELECT `exp_id`, `research_project_id`, `exp_session_id`, `baseline_branch_name`, `exp_branch_name`, `exp_result_path`, `atom_id`, `exp_result_summary_path`, `exp_plan_path`, `remote_server_id`, `code_path`, `status`, `started_at`, `finished_at`, `time_created`, `time_updated` FROM `experiment`;--> statement-breakpoint
DROP TABLE `experiment`;--> statement-breakpoint
ALTER TABLE `__new_experiment` RENAME TO `experiment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `experiment_research_project_idx` ON `experiment` (`research_project_id`);--> statement-breakpoint
CREATE INDEX `experiment_session_idx` ON `experiment` (`exp_session_id`);--> statement-breakpoint
CREATE INDEX `experiment_atom_idx` ON `experiment` (`atom_id`);