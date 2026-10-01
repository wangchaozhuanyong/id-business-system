CREATE TABLE `id_business_v2_quick_actions` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `title` VARCHAR(80) NOT NULL,
  `content` TEXT NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  INDEX `id_business_v2_quick_actions_user_id_deleted_at_updated_at_idx` (`user_id`, `deleted_at`, `updated_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `id_business_v2_quick_actions`
  ADD CONSTRAINT `id_business_v2_quick_actions_user_id_fkey`
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
