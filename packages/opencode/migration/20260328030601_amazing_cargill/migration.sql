CREATE TABLE `remote_server` (
	`id` text PRIMARY KEY,
	`config` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `experiment` ADD `remote_server_id` text REFERENCES remote_server(id);