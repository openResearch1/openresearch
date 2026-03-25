ALTER TABLE `experiment` ADD `research_project_id` text NOT NULL REFERENCES research_project(research_project_id);--> statement-breakpoint
ALTER TABLE `experiment` ADD `exp_session_id` text REFERENCES session(id);--> statement-breakpoint
ALTER TABLE `experiment` ADD `baseline_branch_name` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `exp_branch_name` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `exp_result_path` text;--> statement-breakpoint
ALTER TABLE `experiment` ADD `exp_result_summary_path` text;--> statement-breakpoint
CREATE INDEX `experiment_research_project_idx` ON `experiment` (`research_project_id`);--> statement-breakpoint
CREATE INDEX `experiment_session_idx` ON `experiment` (`exp_session_id`);--> statement-breakpoint
ALTER TABLE `experiment` DROP COLUMN `code_info`;--> statement-breakpoint
ALTER TABLE `experiment` DROP COLUMN `result`;