UPDATE `atom_relation` AS `current`
SET
	`note` = COALESCE(`current`.`note`, (SELECT `legacy`.`note` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'formalizes')),
	`time_created` = MIN(`current`.`time_created`, (SELECT `legacy`.`time_created` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'formalizes')),
	`time_updated` = MAX(`current`.`time_updated`, (SELECT `legacy`.`time_updated` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'formalizes'))
WHERE `current`.`relation_type` = 'formalized_by' AND EXISTS (SELECT 1 FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'formalizes');
--> statement-breakpoint
UPDATE OR IGNORE `atom_relation` SET `relation_type` = 'formalized_by' WHERE `relation_type` = 'formalizes';
--> statement-breakpoint
DELETE FROM `atom_relation` WHERE `relation_type` = 'formalizes';
--> statement-breakpoint
UPDATE `atom_relation` AS `current`
SET
	`note` = COALESCE(`current`.`note`, (SELECT `legacy`.`note` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'analyzes')),
	`time_created` = MIN(`current`.`time_created`, (SELECT `legacy`.`time_created` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'analyzes')),
	`time_updated` = MAX(`current`.`time_updated`, (SELECT `legacy`.`time_updated` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'analyzes'))
WHERE `current`.`relation_type` = 'analyzed_by' AND EXISTS (SELECT 1 FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'analyzes');
--> statement-breakpoint
UPDATE OR IGNORE `atom_relation` SET `relation_type` = 'analyzed_by' WHERE `relation_type` = 'analyzes';
--> statement-breakpoint
DELETE FROM `atom_relation` WHERE `relation_type` = 'analyzes';
--> statement-breakpoint
UPDATE `atom_relation` AS `current`
SET
	`note` = COALESCE(`current`.`note`, (SELECT `legacy`.`note` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'validates')),
	`time_created` = MIN(`current`.`time_created`, (SELECT `legacy`.`time_created` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'validates')),
	`time_updated` = MAX(`current`.`time_updated`, (SELECT `legacy`.`time_updated` FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'validates'))
WHERE `current`.`relation_type` = 'evaluated_by' AND EXISTS (SELECT 1 FROM `atom_relation` AS `legacy` WHERE `legacy`.`atom_id_source` = `current`.`atom_id_source` AND `legacy`.`atom_id_target` = `current`.`atom_id_target` AND `legacy`.`relation_type` = 'validates');
--> statement-breakpoint
UPDATE OR IGNORE `atom_relation` SET `relation_type` = 'evaluated_by' WHERE `relation_type` = 'validates';
--> statement-breakpoint
DELETE FROM `atom_relation` WHERE `relation_type` = 'validates';
