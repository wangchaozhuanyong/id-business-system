CREATE TABLE IF NOT EXISTS id_recharge_code_returns (
  operation_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  cdk_code VARCHAR(32) NOT NULL,
  plan_type VARCHAR(16) NOT NULL,
  returned_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_id_recharge_code_return_code (cdk_code),
  CONSTRAINT fk_id_recharge_code_return_code FOREIGN KEY (cdk_code)
    REFERENCES cdk_codes (cdk_code) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
