import postcss from 'postcss';

const sharedOverlayRoot =
  /(?:^|,)\s*(?:html\[data-v2-theme(?:=[^\]]+)?\]\s+)?(?:\.el-(?:overlay|drawer|dialog|message(?:-box)?|notification)(?:__[a-z-]+)?|\.v2-(?:form-drawer(?:__[a-z-]+)?|confirm-dialog(?:__[a-z-]+)?|submit-disabled-reason|horizontal-form))(?=[\s.#:[>+~]|$)/;

// 基础弹层皮肤不能依赖懒加载的后台布局；媒体条件不同的规则属于合法响应式变化。
export function inspectSharedSkinStyles(source, projectPath) {
  const tree = postcss.parse(source);
  const issues = [];
  const declarations = new Map();
  const isBase = projectPath === 'apps/admin/src/v2/styles/base.css';

  tree.walkRules((rule) => {
    if (!isBase && sharedOverlayRoot.test(rule.selector)) {
      issues.push(`第 ${rule.source.start.line} 行：基础弹层与共享表单规则只能在 base.css 定义`);
    }

    if (!isBase && /\.(?:app-button|el-button)(?=[\s.:#),>+~]|$)/.test(rule.selector)) {
      for (const declaration of rule.nodes.filter((node) => node.type === 'decl')) {
        if (
          /^(?:color|background(?:-.*)?|font(?:-size|-weight|-family)?|line-height|border-color|border-radius|box-shadow|transition|transform)$/.test(
            declaration.prop
          )
        ) {
          issues.push(
            `第 ${declaration.source.start.line} 行：操作按钮 ${declaration.prop} 必须复用 base.css 的共享状态皮肤`
          );
        }
      }
    }

    const conditions = [];
    for (let parent = rule.parent; parent?.type !== 'root'; parent = parent?.parent) {
      if (!parent) break;
      if (parent.type === 'atrule') conditions.unshift(`@${parent.name} ${parent.params}`);
    }
    const selector = rule.selector.replace(/\s+/g, ' ').trim();
    const scope = JSON.stringify([conditions, selector]);
    for (const declaration of rule.nodes.filter((node) => node.type === 'decl')) {
      const key = JSON.stringify([scope, declaration.prop]);
      const previous = declarations.get(key);
      if (previous) {
        issues.push(
          `第 ${declaration.source.start.line} 行：${selector} 的 ${declaration.prop} 重复定义（首次在第 ${previous} 行），请合并规则`
        );
      } else declarations.set(key, declaration.source.start.line);
    }
  });
  return issues;
}
