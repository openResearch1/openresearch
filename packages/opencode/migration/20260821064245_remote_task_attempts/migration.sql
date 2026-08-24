DROP INDEX IF EXISTS `remote_task_exp_kind_resource_idx`;--> statement-breakpoint
CREATE INDEX `remote_task_exp_kind_resource_key_idx` ON `remote_task` (`exp_id`,`kind`,`resource_key`);