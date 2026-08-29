ALTER TABLE `devices` ADD `token_hash` text;--> statement-breakpoint
ALTER TABLE `email_tokens` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_idx` ON `devices` (`token_hash`);
