ALTER TABLE `id_business_v2_quick_actions`
  ADD COLUMN `sort_order` INTEGER NULL,
  ADD INDEX `id_business_v2_quick_actions_user_id_deleted_at_sort_order_idx` (`user_id`, `deleted_at`, `sort_order`);
