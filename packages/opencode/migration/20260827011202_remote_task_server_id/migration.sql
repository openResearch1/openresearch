ALTER TABLE `remote_task` ADD `remote_server_id` text;--> statement-breakpoint
WITH `task_identity` AS (
	SELECT
		`task_id`,
		COALESCE(json_extract(`server`, '$.mode'), 'direct') AS `mode`,
		json_extract(`server`, '$.address') AS `address`,
		json_extract(`server`, '$.port') AS `port`,
		json_extract(`server`, '$.user') AS `user`,
		json_extract(`server`, '$.host_alias') AS `host_alias`,
		json_extract(`server`, '$.ssh_config_path') AS `ssh_config_path`
	FROM `remote_task`
	WHERE json_valid(`server`)
),
`server_identity` AS (
	SELECT
		`id`,
		COALESCE(json_extract(`config`, '$.mode'), 'direct') AS `mode`,
		json_extract(`config`, '$.address') AS `address`,
		json_extract(`config`, '$.port') AS `port`,
		json_extract(`config`, '$.user') AS `user`,
		json_extract(`config`, '$.host_alias') AS `host_alias`,
		json_extract(`config`, '$.ssh_config_path') AS `ssh_config_path`
	FROM `remote_server`
	WHERE json_valid(`config`)
),
`matches` AS (
	SELECT `task_identity`.`task_id`, `server_identity`.`id`
	FROM `task_identity`
	INNER JOIN `server_identity` ON
		`task_identity`.`mode` = `server_identity`.`mode`
		AND (
			(
				`task_identity`.`mode` = 'direct'
				AND `task_identity`.`address` = `server_identity`.`address`
				AND `task_identity`.`port` = `server_identity`.`port`
				AND `task_identity`.`user` = `server_identity`.`user`
			)
			OR (
				`task_identity`.`mode` = 'ssh_config'
				AND `task_identity`.`host_alias` = `server_identity`.`host_alias`
				AND COALESCE(`task_identity`.`ssh_config_path`, '') = COALESCE(`server_identity`.`ssh_config_path`, '')
				AND COALESCE(`task_identity`.`user`, '') = COALESCE(`server_identity`.`user`, '')
			)
		)
),
`resolved` AS (
	SELECT `task_id`, MIN(`id`) AS `id`
	FROM `matches`
	GROUP BY `task_id`
	HAVING COUNT(*) = 1
)
UPDATE `remote_task`
SET `remote_server_id` = (
	SELECT `resolved`.`id`
	FROM `resolved`
	WHERE `resolved`.`task_id` = `remote_task`.`task_id`
)
WHERE `task_id` IN (SELECT `task_id` FROM `resolved`);
