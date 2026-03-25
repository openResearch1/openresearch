ALTER TABLE `experiment` ADD `exp_plan_path` text;--> statement-breakpoint
ALTER TABLE `atom` DROP COLUMN `atom_experiments_plan_path`;