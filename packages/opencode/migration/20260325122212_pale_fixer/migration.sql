ALTER TABLE `experiment` ADD `atom_id` text REFERENCES atom(atom_id);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_atom` (
	`atom_id` text PRIMARY KEY,
	`research_project_id` text NOT NULL,
	`atom_name` text NOT NULL,
	`atom_type` text NOT NULL,
	`atom_claim_path` text,
	`atom_evidence_type` text NOT NULL,
	`atom_experiments_plan_path` text,
	`atom_evidence_status` text DEFAULT 'pending' NOT NULL,
	`atom_evidence_path` text,
	`atom_evidence_assessment_path` text,
	`article_id` text,
	`session_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_atom_research_project_id_research_project_research_project_id_fk` FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_atom_article_id_article_article_id_fk` FOREIGN KEY (`article_id`) REFERENCES `article`(`article_id`) ON DELETE SET NULL,
	CONSTRAINT `fk_atom_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_atom`(`atom_id`, `research_project_id`, `atom_name`, `atom_type`, `atom_claim_path`, `atom_evidence_type`, `atom_experiments_plan_path`, `atom_evidence_status`, `atom_evidence_path`, `atom_evidence_assessment_path`, `article_id`, `session_id`, `time_created`, `time_updated`) SELECT `atom_id`, `research_project_id`, `atom_name`, `atom_type`, `atom_claim_path`, `atom_evidence_type`, `atom_experiments_plan_path`, `atom_evidence_status`, `atom_evidence_path`, `atom_evidence_assessment_path`, `article_id`, `session_id`, `time_created`, `time_updated` FROM `atom`;--> statement-breakpoint
DROP TABLE `atom`;--> statement-breakpoint
ALTER TABLE `__new_atom` RENAME TO `atom`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `atom_exp_idx`;--> statement-breakpoint
CREATE INDEX `atom_research_project_idx` ON `atom` (`research_project_id`);--> statement-breakpoint
CREATE INDEX `atom_session_idx` ON `atom` (`session_id`);--> statement-breakpoint
CREATE INDEX `experiment_atom_idx` ON `experiment` (`atom_id`);