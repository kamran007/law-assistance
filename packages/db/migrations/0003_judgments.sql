CREATE TABLE `judgment_chunks` (
	`chunk_id` binary(16) NOT NULL,
	`judgment_id` binary(16) NOT NULL,
	`chunk_index` smallint NOT NULL,
	`paragraph_from` smallint,
	`paragraph_to` smallint,
	`chunk_text` text NOT NULL,
	`embedding_model` varchar(64),
	`indexed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `judgment_chunks_chunk_id` PRIMARY KEY(`chunk_id`),
	CONSTRAINT `uq_jchunks_judgment_idx` UNIQUE(`judgment_id`,`chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `judgment_revisions` (
	`revision_id` binary(16) NOT NULL,
	`judgment_id` binary(16) NOT NULL,
	`pdf_sha256` varchar(64),
	`stored_pdf_key` varchar(500),
	`full_text` mediumtext,
	`replaced_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `judgment_revisions_revision_id` PRIMARY KEY(`revision_id`)
);
--> statement-breakpoint
CREATE TABLE `judgment_statute_refs` (
	`reference_id` binary(16) NOT NULL,
	`judgment_id` binary(16) NOT NULL,
	`statute_id` binary(16),
	`normalized_section_key` varchar(16),
	`raw_reference_text` text NOT NULL,
	`paragraph_numbers` json NOT NULL,
	`found_in` enum('KEY_WORDS','BODY') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `judgment_statute_refs_reference_id` PRIMARY KEY(`reference_id`)
);
--> statement-breakpoint
CREATE TABLE `judgments` (
	`judgment_id` binary(16) NOT NULL,
	`source` enum('SCOB') NOT NULL DEFAULT 'SCOB',
	`issue_number` smallint NOT NULL,
	`issue_year` smallint NOT NULL,
	`division` enum('AD','HCD') NOT NULL,
	`serial_number` smallint NOT NULL,
	`citation` varchar(100) NOT NULL,
	`case_number` varchar(500),
	`parties` text NOT NULL,
	`authoring_judge` varchar(200),
	`bench` json,
	`decision_date` date,
	`decision_date_source` enum('PDF_RULE','PDF_LLM','MANUAL'),
	`key_words` text NOT NULL,
	`summary` mediumtext,
	`key_ratio_paragraphs` json NOT NULL,
	`language` enum('EN','BN','MIXED') NOT NULL DEFAULT 'EN',
	`full_text` mediumtext,
	`source_pdf_url` varchar(500) NOT NULL,
	`stored_pdf_key` varchar(500),
	`pdf_sha256` varchar(64),
	`listing_html_s3_key` varchar(500),
	`normalized_section_keys` json NOT NULL,
	`extraction_status` enum('OK','OCR_USED','NEEDS_REVIEW') NOT NULL DEFAULT 'NEEDS_REVIEW',
	`last_synced_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `judgments_judgment_id` PRIMARY KEY(`judgment_id`),
	CONSTRAINT `uq_judgments_natural` UNIQUE(`source`,`issue_number`,`division`,`serial_number`)
);
--> statement-breakpoint
ALTER TABLE `judgment_chunks` ADD CONSTRAINT `judgment_chunks_judgment_id_judgments_judgment_id_fk` FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`judgment_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `judgment_revisions` ADD CONSTRAINT `judgment_revisions_judgment_id_judgments_judgment_id_fk` FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`judgment_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `judgment_statute_refs` ADD CONSTRAINT `judgment_statute_refs_judgment_id_judgments_judgment_id_fk` FOREIGN KEY (`judgment_id`) REFERENCES `judgments`(`judgment_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `judgment_statute_refs` ADD CONSTRAINT `judgment_statute_refs_statute_id_statutes_statute_id_fk` FOREIGN KEY (`statute_id`) REFERENCES `statutes`(`statute_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_jrev_judgment` ON `judgment_revisions` (`judgment_id`);--> statement-breakpoint
CREATE INDEX `ix_jrefs_section` ON `judgment_statute_refs` (`statute_id`,`normalized_section_key`);--> statement-breakpoint
CREATE INDEX `ix_jrefs_judgment` ON `judgment_statute_refs` (`judgment_id`);--> statement-breakpoint
CREATE INDEX `ix_judgments_decision` ON `judgments` (`decision_date`);--> statement-breakpoint
CREATE INDEX `ix_judgments_status` ON `judgments` (`extraction_status`);--> statement-breakpoint
-- Keyword arm of case-law search (TRD §4.2); ngram parser as for statutes (migration 0001). Hand-written: drizzle-kit cannot express WITH PARSER.
ALTER TABLE `judgments` ADD FULLTEXT INDEX `ft_judgments_text` (`parties`, `key_words`, `summary`) WITH PARSER ngram;
