CREATE TABLE `conflicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`canonical_track_id` integer NOT NULL,
	`provider` text NOT NULL,
	`change` text NOT NULL,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_track_id`) REFERENCES `canonical_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conflicts_open` ON `conflicts` (`collection_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`canonical_track_id` integer NOT NULL,
	`state` text NOT NULL,
	`changed_at` text NOT NULL,
	`changed_by` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_track_id`) REFERENCES `canonical_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_collection_track` ON `memberships` (`collection_id`,`canonical_track_id`);--> statement-breakpoint
CREATE TABLE `pull_holds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`collection_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`reason` text NOT NULL,
	`before` integer NOT NULL,
	`removing` integer NOT NULL,
	`detected_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`collection_id` integer NOT NULL,
	`provider_collection_id` text,
	`taken_at` text NOT NULL,
	`items` text NOT NULL,
	`run_id` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `snapshots_provider_collection` ON `snapshots` (`provider`,`collection_id`);--> statement-breakpoint
ALTER TABLE `sync_runs` ADD `provider` text;