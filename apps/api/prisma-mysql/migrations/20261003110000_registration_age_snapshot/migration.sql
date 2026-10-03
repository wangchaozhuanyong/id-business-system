-- 新任务固定轮换年龄；旧任务保留原生日，不回填历史年龄。
ALTER TABLE `id_business_v2_registration_jobs`
  ADD COLUMN `registration_age` INTEGER NULL,
  ADD CONSTRAINT `id_business_v2_registration_jobs_age_check`
    CHECK (`registration_age` IS NULL OR `registration_age` BETWEEN 20 AND 45);
