-- Custom migration: rebuild the ngram FULLTEXT indexes without stopwords.
-- With the ngram parser InnoDB drops every ngram that CONTAINS a stopword, and the default list has
-- the single letters "a" and "i": "Karim" (ka, ar, ri, im) had no tokens left and could never be
-- found. The stopword setting is fixed when an index is built, so turn it off for this session
-- (the migrator uses one connection) and rebuild. Bangla text was not affected.
SET SESSION innodb_ft_enable_stopword = OFF;
--> statement-breakpoint
ALTER TABLE `statute_sections` DROP INDEX `ft_sections_text`;
--> statement-breakpoint
ALTER TABLE `statute_sections` ADD FULLTEXT INDEX `ft_sections_text` (`marginal_heading`, `content_body`) WITH PARSER ngram;
--> statement-breakpoint
ALTER TABLE `statutes` DROP INDEX `ft_statutes_title`;
--> statement-breakpoint
ALTER TABLE `statutes` ADD FULLTEXT INDEX `ft_statutes_title` (`title_en`, `title_bn`) WITH PARSER ngram;
--> statement-breakpoint
ALTER TABLE `judgments` DROP INDEX `ft_judgments_text`;
--> statement-breakpoint
ALTER TABLE `judgments` ADD FULLTEXT INDEX `ft_judgments_text` (`parties`, `key_words`, `summary`) WITH PARSER ngram;
--> statement-breakpoint
SET SESSION innodb_ft_enable_stopword = ON;
