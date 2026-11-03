-- Custom migration: things drizzle-kit cannot express (TRD §4.2).

-- Keyword arm of hybrid search. The ngram parser tokenizes Bangla/English without relying on
-- word segmentation; token size is configured on the server (ngram_token_size=2, see docker-compose).
ALTER TABLE `statute_sections` ADD FULLTEXT INDEX `ft_sections_text` (`marginal_heading`, `content_body`) WITH PARSER ngram;
--> statement-breakpoint
ALTER TABLE `statutes` ADD FULLTEXT INDEX `ft_statutes_title` (`title_en`, `title_bn`) WITH PARSER ngram;
--> statement-breakpoint

-- Only LAWYER/JUDGE owners may have a case conversation (App Flow §5.2). Citizens' conversations
-- must have case_file_id NULL. The service layer enforces this too; the trigger is the backstop.
CREATE TRIGGER `trg_conversations_case_role_ins` BEFORE INSERT ON `conversations`
FOR EACH ROW
BEGIN
  IF NEW.case_file_id IS NOT NULL
     AND (SELECT `role` FROM `users` WHERE `user_id` = NEW.owner_user_id) NOT IN ('LAWYER', 'JUDGE') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_CONVERSATION_ROLE_FORBIDDEN';
  END IF;
  IF NEW.case_file_id IS NOT NULL
     AND (SELECT `owner_user_id` FROM `case_files` WHERE `case_file_id` = NEW.case_file_id) <> NEW.owner_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_CONVERSATION_OWNER_MISMATCH';
  END IF;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_conversations_case_role_upd` BEFORE UPDATE ON `conversations`
FOR EACH ROW
BEGIN
  IF NOT (NEW.case_file_id <=> OLD.case_file_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CASE_CONVERSATION_IMMUTABLE';
  END IF;
END;
