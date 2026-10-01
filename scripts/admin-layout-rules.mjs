import { NodeTypes, parse as parseTemplate } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import postcss from 'postcss';

const sharedGeometry =
  /\.(?:v2-page-layout|v2-page-stack|v2-page-overview|v2-overview-metric|v2-list-toolbar)(?:[\s.:#[>+~]|__|$)/;
const geometryProperties =
  /^(?:display|(?:row-|column-)?gap|padding(?:-.+)?|margin(?:-.+)?|align-items|grid-template-columns|font-size|line-height)$/;

export function inspectLayoutComponent(source, filename) {
  const { descriptor } = parseSfc(source, { filename });
  const issues = [];
  const rootClasses = [];
  if (!descriptor.template) return { issues, rootClasses };
  const template = parseTemplate(descriptor.template.content, { comments: false });
  const elements = template.children.filter((node) => node.type === NodeTypes.ELEMENT);
  const route = /features\/.*(?:View|VendureMailboxManager)\.vue$/.test(filename);
  for (const element of elements) {
    const classes =
      element.props
        .find((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class')
        ?.value?.content.split(/\s+/) ?? [];
    if (route && ['section', 'div', 'main'].includes(element.tag)) {
      rootClasses.push(...classes);
      if (!classes.includes('v2-page-layout')) issues.push('页面原生根容器必须使用 v2-page-layout');
    }
  }
  function collectStacks(node) {
    const classes =
      node.props
        ?.find((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === 'class')
        ?.value?.content.split(/\s+/) ?? [];
    if (classes.includes('v2-page-stack')) rootClasses.push(...classes);
    for (const child of node.children ?? []) collectStacks(child);
  }
  collectStacks(template);
  // A delegated route inherits the canonical layout from its rendered component.
  if (/features\/.*Toolbar\.vue$/.test(filename) && !source.includes('<V2ListToolbar')) {
    issues.push('列表筛选工具栏必须复用 V2ListToolbar');
  }
  if (
    /features\//.test(filename) &&
    /(?:overview|hero)__metrics/.test(descriptor.template.content) &&
    !source.includes('<V2PageOverview')
  ) {
    issues.push('页首总览必须复用 V2PageOverview 和 V2OverviewMetric');
  }
  for (const style of descriptor.styles)
    issues.push(...inspectLayoutStyles(style.content, filename, rootClasses));
  return { issues, rootClasses };
}

export function inspectLayoutStyles(source, filename, rootClasses = []) {
  const issues = [];
  const common =
    /\/components\/V2(?:PageOverview|OverviewMetric|ListToolbar|PageContext|SectionHeading)\.vue$/.test(
      filename
    );
  postcss.parse(source, { from: filename }).walkRules((rule) => {
    const localRoot = rule.selectors.some(
      (selector) => /^\.[\w-]+$/.test(selector) && rootClasses.includes(selector.slice(1))
    );
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--v2-layout-') && !filename.endsWith('/styles/layout.css')) {
        issues.push(`${rule.selector}: 全局布局令牌只能在 layout.css 中定义`);
      }
      if (
        localRoot &&
        /^(?:row-)?gap$/.test(decl.prop) &&
        decl.value !== 'var(--v2-layout-section-gap)'
      ) {
        issues.push(`${rule.selector}: 页面模块间距必须使用 --v2-layout-section-gap`);
      }
      if (
        !common &&
        !filename.endsWith('/styles/layout.css') &&
        sharedGeometry.test(rule.selector) &&
        geometryProperties.test(decl.prop)
      ) {
        issues.push(`${rule.selector}: 公共布局几何只能在公共组件或 layout.css 中定义`);
      }
      if (
        !filename.endsWith('/styles/records.css') &&
        /\.v2-[\w-]+(?:list__header|list__heading|account-list-heading|security-records__heading)\s+\.v2-section-heading(?:__actions)?$/.test(
          rule.selector
        ) &&
        geometryProperties.test(decl.prop)
      ) {
        issues.push(
          `${rule.selector}: 列表标题与总数的几何由 records.css 和 V2SectionHeading 管理`
        );
      }
      if (
        !filename.endsWith('/styles/base.css') &&
        !filename.includes('/views/') &&
        rule.selector.includes('.el-form-item__label') &&
        geometryProperties.test(decl.prop)
      ) {
        issues.push(`${rule.selector}: 表单标签对齐由 base.css 管理，页面只可调整标签宽度`);
      }
    });
  });
  return issues;
}
