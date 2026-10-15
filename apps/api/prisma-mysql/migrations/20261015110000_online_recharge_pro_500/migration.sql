-- Append the new tier only. Existing values, defaults and historical records stay unchanged.
ALTER TABLE `online_recharge_codes` MODIFY `plan` ENUM('plus', 'pro_5x', 'pro_20x', 'pro_500') NOT NULL;
ALTER TABLE `online_recharge_tasks` MODIFY `plan` ENUM('plus', 'pro_5x', 'pro_20x', 'pro_500') NOT NULL DEFAULT 'plus';
ALTER TABLE `online_recharge_bills` MODIFY `plan` ENUM('plus', 'pro_5x', 'pro_20x', 'pro_500') NOT NULL;
