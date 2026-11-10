CREATE TABLE IF NOT EXISTS id_recharge_proxy_country_labels (
  proxy_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  audit_json JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_recharge_proxy_country_asset
    FOREIGN KEY (proxy_id) REFERENCES proxy_assets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
