CREATE TABLE `staged_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`canonical_track_id` integer NOT NULL,
	`provider` text NOT NULL,
	`change` text NOT NULL,
	`staged_at` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_track_id`) REFERENCES `canonical_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staged_changes_collection_track_provider` ON `staged_changes` (`collection_id`,`canonical_track_id`,`provider`);