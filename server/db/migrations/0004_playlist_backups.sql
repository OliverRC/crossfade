CREATE TABLE `playlist_backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`playlist_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`access_type` text,
	`items` text NOT NULL,
	`reason` text NOT NULL,
	`kept_playlist_id` text,
	`saved_at` text NOT NULL,
	`deleted_at` text
);
