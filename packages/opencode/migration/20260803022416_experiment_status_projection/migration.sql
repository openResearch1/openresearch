WITH `latest` AS (
	SELECT `watch`.*
	FROM `experiment_execution_watch` AS `watch`
	WHERE `watch`.`watch_id` = (
		SELECT `candidate`.`watch_id`
		FROM `experiment_execution_watch` AS `candidate`
		WHERE `candidate`.`exp_id` = `watch`.`exp_id`
		ORDER BY `candidate`.`time_updated` DESC, `candidate`.`watch_id` DESC
		LIMIT 1
	)
)
UPDATE `experiment`
SET
	`status` = CASE (SELECT `status` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`)
		WHEN 'pending' THEN 'pending'
		WHEN 'running' THEN 'running'
		WHEN 'finished' THEN 'done'
		WHEN 'failed' THEN 'failed'
		WHEN 'canceled' THEN 'idle'
	END,
	`started_at` = CASE
		WHEN (SELECT `status` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`) = 'pending' THEN NULL
		ELSE COALESCE(
			(SELECT `started_at` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`),
			`started_at`
		)
	END,
	`finished_at` = CASE
		WHEN (SELECT `status` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`) IN ('finished', 'failed', 'canceled')
		THEN COALESCE(
			(SELECT `finished_at` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`),
			(SELECT `time_updated` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`)
		)
		ELSE NULL
	END,
	`time_updated` = MAX(
		`time_updated`,
		(SELECT `time_updated` FROM `latest` WHERE `latest`.`exp_id` = `experiment`.`exp_id`)
	)
WHERE `exp_id` IN (SELECT `exp_id` FROM `latest`);
