CREATE TABLE `remote_task_listener` (
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `remote_task_listener_pk` PRIMARY KEY(`task_id`, `agent_id`),
	CONSTRAINT `fk_remote_task_listener_task_id_remote_task_task_id_fk` FOREIGN KEY (`task_id`) REFERENCES `remote_task`(`task_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_remote_task_listener_agent_id_collab_agent_id_fk` FOREIGN KEY (`agent_id`) REFERENCES `collab_agent`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `remote_task_listener_agent_idx` ON `remote_task_listener` (`agent_id`);