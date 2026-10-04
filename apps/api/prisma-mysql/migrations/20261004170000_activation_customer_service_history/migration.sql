-- Maintain the existing customer history summary in the activation's transaction.
-- No financial backfill or change to historical activation/payment records.
CREATE TRIGGER `idv2_activation_customer_service_history`
AFTER INSERT ON `id_business_v2_activations`
FOR EACH ROW
INSERT INTO `id_business_v2_customer_services` (
  `customer_id`, `option_id`, `source`, `first_opened_at`, `last_opened_at`,
  `activation_count`, `created_at`
)
SELECT NEW.`customer_id`, NEW.`service_option_id`, 'activation',
  MIN(`opened_at`), MAX(`opened_at`), COUNT(*), NEW.`opened_at`
FROM `id_business_v2_activations`
WHERE `customer_id` = NEW.`customer_id` AND `service_option_id` = NEW.`service_option_id`
ON DUPLICATE KEY UPDATE
  `first_opened_at` = LEAST(COALESCE(`first_opened_at`, NEW.`opened_at`), NEW.`opened_at`),
  `last_opened_at` = GREATEST(COALESCE(`last_opened_at`, NEW.`opened_at`), NEW.`opened_at`),
  `activation_count` = IF(`source` = 'activation', `activation_count` + 1, VALUES(`activation_count`)),
  `source` = 'activation';
