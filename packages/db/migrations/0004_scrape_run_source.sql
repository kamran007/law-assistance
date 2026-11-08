ALTER TABLE `scrape_runs` MODIFY COLUMN `kind` enum('NIGHTLY','FULL','MANUAL','WEEKLY','BACKFILL') NOT NULL;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `source` enum('BDLAWS','SCOB') DEFAULT 'BDLAWS' NOT NULL;--> statement-breakpoint
ALTER TABLE `scrape_runs` ADD `details` json;