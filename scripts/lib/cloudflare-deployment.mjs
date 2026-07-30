const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function getSoleActiveVersionId(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  const activeVersions = versions.filter(
    (version) =>
      Number(version?.percentage) > 0 &&
      typeof version?.version_id === 'string' &&
      VERSION_ID_PATTERN.test(version.version_id)
  );

  if (activeVersions.length !== 1 || Number(activeVersions[0]?.percentage) !== 100) {
    throw new Error('当前生产部署必须是单一版本承载 100% 流量，才能执行自动回滚发布');
  }

  return activeVersions[0].version_id;
}
