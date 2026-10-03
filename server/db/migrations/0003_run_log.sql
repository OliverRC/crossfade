CREATE TABLE `sync_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`at` text NOT NULL,
	`level` text NOT NULL,
	`stage` text,
	`message` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_events_run` ON `sync_events` (`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `stages` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `attempts` integer DEFAULT 0 NOT NULL;