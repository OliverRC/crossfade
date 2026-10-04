ALTER TABLE `staged_changes` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `staged_changes` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `staged_changes` ADD `last_attempt_at` text;