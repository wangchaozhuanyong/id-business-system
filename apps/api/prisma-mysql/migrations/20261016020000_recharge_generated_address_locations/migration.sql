-- Preserve every existing address while allowing the independent US templates.
ALTER TABLE `id_business_v2_recharge_addresses`
  DROP CHECK `id_business_v2_recharge_addresses_fixed_location_chk`,
  ADD CONSTRAINT `id_business_v2_recharge_addresses_us_location_chk`
    CHECK (`country` = 'US' AND CHAR_LENGTH(TRIM(`city`)) > 0
      AND CHAR_LENGTH(TRIM(`state`)) > 0
      AND REGEXP_LIKE(`postal_code`, '^[0-9]{5}$'));
