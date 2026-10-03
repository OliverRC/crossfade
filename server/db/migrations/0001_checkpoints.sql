CREATE TABLE `fetch_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`collection_key` text NOT NULL,
	`name` text NOT NULL,
	`tracks` text NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fetch_checkpoints_run_collection` ON `fetch_checkpoints` (`run_id`,`provider`,`collection_key`);--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `quota_blocked_until` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `pause` text;--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `playlists` text;