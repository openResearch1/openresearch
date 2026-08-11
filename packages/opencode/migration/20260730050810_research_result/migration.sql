CREATE TABLE `research_result` (
	`research_result_id` text PRIMARY KEY,
	`research_project_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`reviewer_session_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`evaluation` text NOT NULL,
	`atoms_json` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_research_result_research_project_id_research_project_research_project_id_fk` FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `research_result_project_idx` ON `research_result` (`research_project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_result_reviewer_session_idx` ON `research_result` (`reviewer_session_id`);