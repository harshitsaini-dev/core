CREATE TABLE `signup_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email_blind_index` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signup_codes_email_idx` ON `signup_codes` (`email_blind_index`);
