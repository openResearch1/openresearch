CREATE TABLE `research_path_atom` (
	`research_path_id` text NOT NULL,
	`atom_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	CONSTRAINT `research_path_atom_pk` PRIMARY KEY(`research_path_id`, `atom_id`),
	CONSTRAINT `fk_research_path_atom_research_path_id_research_path_research_path_id_fk` FOREIGN KEY (`research_path_id`) REFERENCES `research_path`(`research_path_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_research_path_atom_atom_id_atom_atom_id_fk` FOREIGN KEY (`atom_id`) REFERENCES `atom`(`atom_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `research_path` (
	`research_path_id` text PRIMARY KEY,
	`research_project_id` text NOT NULL,
	`creator_session_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`summary` text,
	`status` text DEFAULT 'active' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_research_path_research_project_id_research_project_research_project_id_fk` FOREIGN KEY (`research_project_id`) REFERENCES `research_project`(`research_project_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `research_path_atom_atom_idx` ON `research_path_atom` (`atom_id`);--> statement-breakpoint
CREATE INDEX `research_path_project_status_idx` ON `research_path` (`research_project_id`,`status`);--> statement-breakpoint
CREATE INDEX `research_path_creator_session_idx` ON `research_path` (`creator_session_id`);