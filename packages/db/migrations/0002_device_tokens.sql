CREATE TABLE `device_tokens` (
	`device_token_id` binary(16) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`token` varchar(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`platform` enum('ANDROID','IOS','WEB') NOT NULL,
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `device_tokens_device_token_id` PRIMARY KEY(`device_token_id`),
	CONSTRAINT `uq_device_token` UNIQUE(`token`)
);
--> statement-breakpoint
ALTER TABLE `device_tokens` ADD CONSTRAINT `device_tokens_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_device_user` ON `device_tokens` (`user_id`,`last_seen_at`);