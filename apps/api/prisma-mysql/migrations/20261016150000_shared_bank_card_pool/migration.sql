-- Canonical shared pool. Historical BitBrowser cards, jobs and order foreign keys remain intact.
ALTER TABLE `online_recharge_cards`
 ADD COLUMN `allowed_plans` JSON NOT NULL DEFAULT (JSON_ARRAY('go','plus','pro_5x','pro_20x','pro_500'));

INSERT INTO `online_recharge_cards`
 (`id`,`number_encrypted`,`number_hash`,`last4`,`expiry_month`,`expiry_year`,`holder_name`,
  `status`,`allowed_plans`,`created_at`,`updated_at`)
SELECT UUID(), b.`number_encrypted`,b.`number_hash`,b.`last4`,
 CAST(SUBSTRING(b.`expiry`,1,2) AS UNSIGNED),2000+CAST(SUBSTRING(b.`expiry`,4,2) AS UNSIGNED),'',
 IF(b.`active`,'active','disabled'),JSON_ARRAY('go','plus','pro_5x','pro_20x','pro_500'),b.`created_at`,b.`updated_at`
FROM `id_business_v2_bank_recharge_cards` b
LEFT JOIN `online_recharge_cards` o ON o.`number_hash`=b.`number_hash`
WHERE o.`id` IS NULL AND b.`number_encrypted` IS NOT NULL AND b.`number_hash` IS NOT NULL
 AND b.`expiry` REGEXP '^(0[1-9]|1[0-2])/[0-9]{2}$';

-- A disabled historical card must not become available through the other entry point.
UPDATE `online_recharge_cards` o JOIN `id_business_v2_bank_recharge_cards` b
 ON b.`number_hash`=o.`number_hash` SET o.`status`='disabled'
WHERE b.`active`=FALSE AND o.`status`='active';

-- Preserve the existing BitBrowser metric: distinct accounts with verified/completed charges.
UPDATE `online_recharge_cards` o JOIN (
 SELECT b.`number_hash`, COUNT(DISTINCT r.`account_id`) AS `charged_accounts`
 FROM `id_business_v2_bank_recharge_cards` b
 JOIN `id_business_v2_bank_recharge_orders` r ON r.`card_id`=b.`id`
 WHERE b.`number_hash` IS NOT NULL AND r.`account_id` IS NOT NULL
  AND (r.`verified_at` IS NOT NULL OR r.`status` IN ('completed','refunded'))
 GROUP BY b.`number_hash`
) history ON history.`number_hash`=o.`number_hash`
SET o.`success_count`=o.`success_count`+history.`charged_accounts`;

UPDATE `online_recharge_cards` o
LEFT JOIN `online_recharge_config` c ON c.`id`='global'
SET o.`status`='exhausted'
WHERE o.`status`='active' AND o.`success_count` >= COALESCE(
 CAST(JSON_UNQUOTE(JSON_EXTRACT(c.`settings`,'$.cardMaxSubscriptionCount')) AS UNSIGNED),2);

-- Retain active and uncertain original tasks; never reclaim solely because a timeout elapsed.
UPDATE `online_recharge_cards` o
JOIN `id_business_v2_bank_recharge_cards` b ON b.`number_hash`=o.`number_hash`
JOIN `id_business_v2_recharge_jobs` j ON j.`card_id`=b.`id`
SET o.`lease_owner`=j.`id`,o.`lease_id`=UUID(),o.`lease_version`=o.`lease_version`+1,
 o.`lease_expires_at`=j.`lease_until`
WHERE o.`lease_owner` IS NULL
 AND NOT (
  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.`result`,'$.operator_resolution')),'')='confirmed_no_bank_request'
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.`result`,'$.status')),'')='payment_unknown_resolved'
 )
 AND NOT EXISTS (
  SELECT 1 FROM `id_business_v2_bank_recharge_orders` r
  WHERE r.`recharge_job_id`=j.`id`
   AND (r.`verified_at` IS NOT NULL OR r.`status` IN ('completed','refunded'))
 ) AND
 (j.`state`<>'finished' OR
  (JSON_EXTRACT(j.`result`,'$.payment_attempted')=TRUE
   AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.`result`,'$.payment_status')),'')<>'declined'
   AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(j.`result`,'$.status')),'')<>'subscription_activated'));
