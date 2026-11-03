CREATE TABLE `credential_reviews` (
	`review_id` binary(16) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`reviewer_user_id` binary(16) NOT NULL,
	`decision` enum('APPROVED','REJECTED') NOT NULL,
	`note` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `credential_reviews_review_id` PRIMARY KEY(`review_id`)
);
--> statement-breakpoint
CREATE TABLE `otp_challenges` (
	`challenge_id` binary(16) NOT NULL,
	`contact_identifier` varchar(254) NOT NULL,
	`channel` enum('SMS','EMAIL') NOT NULL,
	`code_hash` varchar(128) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`expires_at` datetime(3) NOT NULL,
	`consumed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `otp_challenges_challenge_id` PRIMARY KEY(`challenge_id`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`token_id` binary(16) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`family_id` binary(16) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`rotated_at` datetime(3),
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `refresh_tokens_token_id` PRIMARY KEY(`token_id`),
	CONSTRAINT `uq_refresh_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` binary(16) NOT NULL,
	`full_name` varchar(200) NOT NULL,
	`contact_identifier` varchar(254) NOT NULL,
	`role` enum('CITIZEN','LAWYER','JUDGE','ADMIN') NOT NULL DEFAULT 'CITIZEN',
	`requested_role` enum('CITIZEN','LAWYER','JUDGE','ADMIN') NOT NULL DEFAULT 'CITIZEN',
	`verification_credential` varchar(100),
	`verification_status` enum('NOT_REQUIRED','PENDING','VERIFIED','REJECTED') NOT NULL DEFAULT 'NOT_REQUIRED',
	`preferred_language` enum('BN','EN') NOT NULL DEFAULT 'BN',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `users_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `uq_users_contact` UNIQUE(`contact_identifier`)
);
--> statement-breakpoint
CREATE TABLE `crpc_schedule_metadata` (
	`schedule_id` binary(16) NOT NULL,
	`statute_id` binary(16) NOT NULL,
	`section_number` varchar(16) NOT NULL,
	`offense_description` text,
	`is_cognizable` boolean NOT NULL,
	`is_bailable` boolean NOT NULL,
	`is_compoundable` boolean NOT NULL,
	`max_punishment` text NOT NULL,
	`triable_by_court` varchar(200) NOT NULL,
	`source_reference` varchar(300),
	`verified_by` varchar(200),
	`verified_at` datetime(3),
	`effective_from` date NOT NULL,
	`effective_to` date,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `crpc_schedule_metadata_schedule_id` PRIMARY KEY(`schedule_id`),
	CONSTRAINT `uq_schedule_section_from` UNIQUE(`statute_id`,`section_number`,`effective_from`)
);
--> statement-breakpoint
CREATE TABLE `section_chunks` (
	`chunk_id` binary(16) NOT NULL,
	`section_id` binary(16) NOT NULL,
	`chunk_index` smallint NOT NULL,
	`chunk_text` text NOT NULL,
	`embedding_model` varchar(64),
	`indexed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `section_chunks_chunk_id` PRIMARY KEY(`chunk_id`),
	CONSTRAINT `uq_chunks_section_idx` UNIQUE(`section_id`,`chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `statute_sections` (
	`section_id` binary(16) NOT NULL,
	`statute_id` binary(16) NOT NULL,
	`chapter_reference` varchar(300),
	`section_number` varchar(32) NOT NULL,
	`normalized_section_key` varchar(16) NOT NULL,
	`marginal_heading` text,
	`content_body` mediumtext NOT NULL,
	`amendment_footnotes` json NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`footnotes_hash` varchar(64) NOT NULL,
	`version_number` int NOT NULL,
	`is_current` boolean NOT NULL,
	`valid_from` date NOT NULL,
	`valid_to` date,
	`valid_from_source` enum('AMENDMENT_FOOTNOTE','ENACTMENT_DATE','DETECTED_ON_SYNC') NOT NULL,
	`current_key` varchar(64) GENERATED ALWAYS AS (IF(is_current, CONCAT(HEX(statute_id), ':', normalized_section_key), NULL)) STORED,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `statute_sections_section_id` PRIMARY KEY(`section_id`),
	CONSTRAINT `uq_sections_current_key` UNIQUE(`current_key`),
	CONSTRAINT `uq_sections_version` UNIQUE(`statute_id`,`normalized_section_key`,`version_number`)
);
--> statement-breakpoint
CREATE TABLE `statutes` (
	`statute_id` binary(16) NOT NULL,
	`bdlaws_act_id` int NOT NULL,
	`act_number` varchar(120),
	`title_en` text,
	`title_bn` text,
	`language` enum('BN','EN') NOT NULL,
	`enacted_date` date,
	`status` enum('ACTIVE','REPEALED') NOT NULL DEFAULT 'ACTIVE',
	`source_url` varchar(500) NOT NULL,
	`raw_html_s3_key` varchar(500),
	`last_synced_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `statutes_statute_id` PRIMARY KEY(`statute_id`),
	CONSTRAINT `uq_statutes_bdlaws_act` UNIQUE(`bdlaws_act_id`)
);
--> statement-breakpoint
CREATE TABLE `artifact_revisions` (
	`revision_id` binary(16) NOT NULL,
	`artifact_id` binary(16) NOT NULL,
	`owner_user_id` binary(16) NOT NULL,
	`version` int NOT NULL,
	`editable_document_html` mediumtext,
	`created_by_device` varchar(100),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `artifact_revisions_revision_id` PRIMARY KEY(`revision_id`)
);
--> statement-breakpoint
CREATE TABLE `case_artifacts` (
	`artifact_id` binary(16) NOT NULL,
	`case_file_id` binary(16) NOT NULL,
	`owner_user_id` binary(16) NOT NULL,
	`artifact_type` enum('FIR_SCAN','CHARGE_SHEET','SEIZURE_LIST','COURT_ORDER','VOICE_DICTATION_DRAFT','COURT_ORDER_NOTE','GD_DRAFT') NOT NULL,
	`template_key` varchar(64),
	`file_storage_key` varchar(500),
	`mime_type` varchar(100),
	`file_sha256` varchar(64),
	`page_count` int,
	`processing_status` enum('UPLOADED','OCR','EXTRACTING','SCHEDULE_LOOKUP','ANALYZING','READY','FAILED'),
	`processing_error` text,
	`ocr_confidence` double,
	`raw_extracted_text` mediumtext,
	`structured_analysis` json,
	`role_analysis` json,
	`editable_document_html` mediumtext,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `case_artifacts_artifact_id` PRIMARY KEY(`artifact_id`)
);
--> statement-breakpoint
CREATE TABLE `case_files` (
	`case_file_id` binary(16) NOT NULL,
	`owner_user_id` binary(16) NOT NULL,
	`title` varchar(300),
	`case_number` varchar(200),
	`court_or_thana` varchar(200),
	`alleged_offense_date` date,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `case_files_case_file_id` PRIMARY KEY(`case_file_id`)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`conversation_id` binary(16) NOT NULL,
	`owner_user_id` binary(16) NOT NULL,
	`case_file_id` binary(16),
	`title` varchar(300),
	`language` enum('BN','EN') NOT NULL DEFAULT 'BN',
	`summary` mediumtext,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `conversations_conversation_id` PRIMARY KEY(`conversation_id`),
	CONSTRAINT `uq_conversations_case` UNIQUE(`case_file_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`message_id` binary(16) NOT NULL,
	`conversation_id` binary(16) NOT NULL,
	`owner_user_id` binary(16) NOT NULL,
	`role` enum('USER','ASSISTANT') NOT NULL,
	`content` mediumtext NOT NULL,
	`input_mode` enum('TEXT','VOICE') NOT NULL DEFAULT 'TEXT',
	`attached_artifact_id` binary(16),
	`citations` json,
	`retrieval_trace` json,
	`law_as_of_date` date,
	`model_id` varchar(64),
	`input_tokens` int,
	`output_tokens` int,
	`latency_ms` int,
	`status` enum('COMPLETE','INTERRUPTED','NO_PROVISION','ERROR') NOT NULL DEFAULT 'COMPLETE',
	`flags` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `messages_message_id` PRIMARY KEY(`message_id`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`actor_user_id` binary(16),
	`action` varchar(100) NOT NULL,
	`entity` varchar(64) NOT NULL,
	`entity_id` varchar(64),
	`details` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`aggregate` varchar(64) NOT NULL,
	`aggregate_id` binary(16) NOT NULL,
	`event_type` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`processed_at` datetime(3),
	CONSTRAINT `outbox_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scrape_events` (
	`event_id` binary(16) NOT NULL,
	`run_id` binary(16) NOT NULL,
	`bdlaws_act_id` int,
	`level` enum('INFO','WARN','ERROR') NOT NULL,
	`message` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `scrape_events_event_id` PRIMARY KEY(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `scrape_runs` (
	`run_id` binary(16) NOT NULL,
	`kind` enum('NIGHTLY','FULL','MANUAL') NOT NULL,
	`status` enum('RUNNING','SUCCEEDED','FAILED','QUARANTINED') NOT NULL DEFAULT 'RUNNING',
	`acts_checked` int NOT NULL DEFAULT 0,
	`sections_changed` int NOT NULL DEFAULT 0,
	`error` text,
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `scrape_runs_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
ALTER TABLE `credential_reviews` ADD CONSTRAINT `credential_reviews_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credential_reviews` ADD CONSTRAINT `credential_reviews_reviewer_user_id_users_user_id_fk` FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_id_users_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `crpc_schedule_metadata` ADD CONSTRAINT `crpc_schedule_metadata_statute_id_statutes_statute_id_fk` FOREIGN KEY (`statute_id`) REFERENCES `statutes`(`statute_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `section_chunks` ADD CONSTRAINT `section_chunks_section_id_statute_sections_section_id_fk` FOREIGN KEY (`section_id`) REFERENCES `statute_sections`(`section_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `statute_sections` ADD CONSTRAINT `statute_sections_statute_id_statutes_statute_id_fk` FOREIGN KEY (`statute_id`) REFERENCES `statutes`(`statute_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_revisions` ADD CONSTRAINT `artifact_revisions_artifact_id_case_artifacts_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `case_artifacts`(`artifact_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `case_artifacts` ADD CONSTRAINT `case_artifacts_case_file_id_case_files_case_file_id_fk` FOREIGN KEY (`case_file_id`) REFERENCES `case_files`(`case_file_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `case_files` ADD CONSTRAINT `case_files_owner_user_id_users_user_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`user_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_owner_user_id_users_user_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`user_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `conversations` ADD CONSTRAINT `conversations_case_file_id_case_files_case_file_id_fk` FOREIGN KEY (`case_file_id`) REFERENCES `case_files`(`case_file_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_conversation_id_conversations_conversation_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`conversation_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_attached_artifact_id_case_artifacts_artifact_id_fk` FOREIGN KEY (`attached_artifact_id`) REFERENCES `case_artifacts`(`artifact_id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scrape_events` ADD CONSTRAINT `scrape_events_run_id_scrape_runs_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `scrape_runs`(`run_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_otp_contact_created` ON `otp_challenges` (`contact_identifier`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_refresh_family` ON `refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `ix_sections_point_in_time` ON `statute_sections` (`statute_id`,`normalized_section_key`,`valid_from`,`valid_to`);--> statement-breakpoint
CREATE INDEX `ix_revisions_owner_artifact` ON `artifact_revisions` (`owner_user_id`,`artifact_id`);--> statement-breakpoint
CREATE INDEX `ix_artifacts_owner_case` ON `case_artifacts` (`owner_user_id`,`case_file_id`);--> statement-breakpoint
CREATE INDEX `ix_artifacts_owner_updated` ON `case_artifacts` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_cases_owner_updated` ON `case_files` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_conversations_owner_updated` ON `conversations` (`owner_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `ix_messages_conversation_created` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_messages_owner` ON `messages` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_entity` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `ix_outbox_unprocessed` ON `outbox_events` (`processed_at`,`id`);--> statement-breakpoint
CREATE INDEX `ix_scrape_events_run` ON `scrape_events` (`run_id`);