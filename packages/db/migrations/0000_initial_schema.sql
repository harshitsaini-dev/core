CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`blob_key` text NOT NULL,
	`item_key_wrapped` text NOT NULL,
	`filename_enc` text NOT NULL,
	`mime_enc` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `vault_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_item_idx` ON `attachments` (`item_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`event` text NOT NULL,
	`ip_hash` text,
	`geo_country` text,
	`ua_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label_enc` text,
	`ua_hash` text NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `devices_user_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `env_var_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`env_var_id` text NOT NULL,
	`key_enc` text NOT NULL,
	`value_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`env_var_id`) REFERENCES `env_vars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `env_var_versions_var_idx` ON `env_var_versions` (`env_var_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `env_vars` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`key_enc` text NOT NULL,
	`value_enc` text NOT NULL,
	`note_enc` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `env_vars_environment_idx` ON `env_vars` (`environment_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name_enc` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`name_enc` text NOT NULL,
	`color` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `folders_user_idx` ON `folders` (`user_id`);--> statement-breakpoint
CREATE TABLE `item_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`data_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `vault_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_versions_item_idx` ON `item_versions` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name_enc` text NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_user_idx` ON `projects` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text,
	`token_hash` text NOT NULL,
	`previous_token_hash` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_idx` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`payload_enc` text NOT NULL,
	`token_blind_index` text NOT NULL,
	`max_views` integer DEFAULT 1 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_idx` ON `shares` (`token_blind_index`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email_blind_index` text NOT NULL,
	`email_enc` text NOT NULL,
	`auth_verifier` text NOT NULL,
	`kdf_salt` text NOT NULL,
	`kdf_params` text NOT NULL,
	`account_key_wrapped` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key_wrapped` text NOT NULL,
	`emergency_kit_acknowledged_at` integer,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_blind_index_idx` ON `users` (`email_blind_index`);--> statement-breakpoint
CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`folder_id` text,
	`type` text NOT NULL,
	`data_enc` text NOT NULL,
	`url_blind_index` text,
	`favorite` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vault_items_user_idx` ON `vault_items` (`user_id`);--> statement-breakpoint
CREATE INDEX `vault_items_sync_idx` ON `vault_items` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `vault_items_folder_idx` ON `vault_items` (`folder_id`);--> statement-breakpoint
CREATE INDEX `vault_items_url_idx` ON `vault_items` (`user_id`,`url_blind_index`);