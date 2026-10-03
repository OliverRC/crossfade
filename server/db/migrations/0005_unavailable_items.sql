CREATE TABLE `unavailable_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`isrc` text,
	`playlist_id` text NOT NULL,
	`playlist_name` text NOT NULL,
	`found_in_playlist_id` text NOT NULL,
	`found_at` text NOT NULL,
	`restored_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `unavailable_items_playlist_item` ON `unavailable_items` (`provider`,`playlist_id`,`item_id`);