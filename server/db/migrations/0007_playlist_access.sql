ALTER TABLE `collection_links` ADD `access` text DEFAULT 'owned' NOT NULL;--> statement-breakpoint
ALTER TABLE `collection_links` ADD `owner_name` text;--> statement-breakpoint
ALTER TABLE `collection_links` DROP COLUMN `is_owned`;