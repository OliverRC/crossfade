CREATE TABLE `canonical_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`isrc` text,
	`title` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `canonical_tracks_isrc` ON `canonical_tracks` (`isrc`);--> statement-breakpoint
CREATE TABLE `collection_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_collection_id` text,
	`is_owned` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_links_provider_collection` ON `collection_links` (`provider`,`provider_collection_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_accounts` (
	`provider` text PRIMARY KEY NOT NULL,
	`provider_user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` text NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`country` text,
	`needs_reconnect` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`error` text,
	`counts` text,
	`result` text
);
--> statement-breakpoint
CREATE TABLE `track_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_track_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_track_id` text,
	`status` text NOT NULL,
	`method` text,
	`confidence` real,
	`unmatched_reason` text,
	`candidate_track_id` text,
	`candidate` text,
	`is_preferred` integer DEFAULT false NOT NULL,
	`last_checked_at` text,
	FOREIGN KEY (`canonical_track_id`) REFERENCES `canonical_tracks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_links_provider_track` ON `track_links` (`provider`,`provider_track_id`);--> statement-breakpoint
CREATE INDEX `track_links_canonical` ON `track_links` (`canonical_track_id`,`provider`);