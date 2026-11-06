const chatgptUrl = 'https://chatgpt.com/';
const sessionUrl = chatgptUrl + 'api/auth/session';

export const workspaceIcon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

const steps = (items, label) => `<ol class="workspace-guide-steps" aria-label="${label}">
  ${items.map(([title, text], index) => `<li><span class="workspace-step-number" aria-hidden="true">${index + 1}</span><div><h3>${title}</h3><p>${text}</p></div></li>`).join('')}
</ol>`;

const demoJson = JSON.stringify(
  {
    user: { id: 'demo-user-invalid', email: 'demo@example.test' },
    accessToken: '[演示凭据已遮蔽]',
    expires: '2099-01-01T00:00:00Z'
  },
  null,
  2
);

function illustration(address, content, caption) {
  return `<figure>
    <div class="workspace-guide-browser">
      <div class="workspace-guide-address"><span aria-hidden="true">● ● ●</span>${address}</div>
      <div class="workspace-guide-example"><small>操作演示 · 非真实账号</small>${content}</div>
    </div>
    <figcaption>${caption}</figcaption>
  </figure>`;
}

export const workspaceGuide = `
  <article id="workspaceGuide" class="workspace-guide" aria-labelledby="workspace-guide-title" hidden>
    <header class="workspace-guide-heading">
      <h2 id="workspace-guide-title">充值使用说明</h2>
      <p>准备好兑换码和目标账号，按下面的步骤操作。</p>
    </header>
    ${steps(
      [
        ['验证兑换码', '输入兑换码，确认绑定的套餐。'],
        ['获取账号资料', '登录目标账号，按下方教程复制完整 JSON。'],
        ['核对并提交', '粘贴资料，核对邮箱和套餐，勾选确认后提交。'],
        ['查看充值结果', '等待处理，离开页面后可用原兑换码查询。']
      ],
      '充值四步'
    )}

    <section aria-labelledby="workspace-guide-session-title">
      <div class="workspace-guide-heading">
        <h2 id="workspace-guide-session-title">如何获取账号资料</h2>
        <p>先登录，再打开资料页。两个页面需在同一浏览器中打开。</p>
      </div>
      <div class="workspace-guide-actions">
        <a class="btn-secondary" href="${chatgptUrl}" target="_blank" rel="noopener noreferrer">登录 ChatGPT ${workspaceIcon('arrow-up-right')}</a>
        <a class="btn-secondary" href="${sessionUrl}" target="_blank" rel="noopener noreferrer">打开账号资料页 ${workspaceIcon('arrow-up-right')}</a>
        <button type="button" class="btn-secondary" id="workspace-copy-session-url">复制页面地址</button>
      </div>
      <div class="workspace-guide-url">
        <label for="workspace-session-url">账号资料页面地址</label>
        <input id="workspace-session-url" type="url" value="${sessionUrl}" readonly spellcheck="false" autocomplete="off">
        <p id="workspace-copy-result" role="status">这里复制的是公开网址，不包含账号或凭据。</p>
      </div>
      <div class="workspace-guide-illustrations">
        ${illustration(
          'chatgpt.com',
          `
          <div class="workspace-guide-example-account">${workspaceIcon('shield-check')}<div><span>当前登录账号</span><strong>d***@example.test</strong></div></div>
          <div class="workspace-guide-example-lines" aria-hidden="true"><span></span><span></span><span></span></div>
          <p>确认是要充值的账号</p>
        `,
          '图 1 · 先核对账号，再获取该账号的资料。'
        )}
        ${illustration(
          '/api/auth/session',
          `
          <pre><code>${demoJson}</code></pre>
          <p>全选完整内容，再复制</p>
        `,
          '图 2 · 复制完整 JSON。示例凭据无效，请使用自己页面的原文。'
        )}
      </div>
      ${steps(
        [
          ['登录并核对账号', '打开 ChatGPT，确认当前登录的是需要充值的账号。'],
          ['打开账号资料页', '保持同一浏览器和登录会话，在新标签页打开资料地址。'],
          ['全选并复制 JSON', '复制从开头 { 到结尾 } 的完整内容。'],
          ['返回充值页粘贴', '粘贴到账号资料输入框，核对识别的邮箱和兑换码绑定的套餐。']
        ],
        '获取账号资料四步'
      )}
      <dl class="workspace-guide-shortcuts">
        <div><dt>Windows</dt><dd><kbd>Ctrl + A</kbd> 全选，<kbd>Ctrl + C</kbd> 复制</dd></div>
        <div><dt>Mac</dt><dd><kbd>⌘ + A</kbd> 全选，<kbd>⌘ + C</kbd> 复制</dd></div>
        <div><dt>手机</dt><dd>长按页面文字，选择「全选」后复制。</dd></div>
      </dl>
    </section>

    <aside class="workspace-guide-safety">
      ${workspaceIcon('shield-check')}
      <div><h3>保护好账号资料</h3>
        <p>账号资料含访问凭据，仅在当前充值表单提交。请勿截图、转发或发给客服。</p>
        <p>若断网、仍在处理或结果待核对，请先用原兑换码查询，避免重复提交。</p>
      </div>
    </aside>

    <section class="workspace-guide-faq" aria-labelledby="workspace-guide-faq-title">
      <h2 id="workspace-guide-faq-title">常见问题</h2>
      <details><summary>账号资料页只显示 {} 怎么办？</summary><p>在同一浏览器登录目标账号，确认登录有效后重新打开资料页。</p></details>
      <details><summary>兑换码能换成其他套餐吗？</summary><p>验证时会识别并锁定兑换码绑定的套餐。要使用另一张兑换码，请在提交前点击「更换兑换码」。</p></details>
      <details><summary>处理中或待核对时怎么办？</summary><p>请用原兑换码查询任务进度。等待结果确认后再决定是否继续操作。</p></details>
    </section>

    <footer class="workspace-guide-footer">
      <div>
        <h3>充值后在哪里确认订阅？</h3>
        <p>工作台可查询充值任务。订阅状态请在目标 ChatGPT 账号内确认。</p>
        <a href="${chatgptUrl}" target="_blank" rel="noopener noreferrer">前往 ChatGPT 查看订阅 ${workspaceIcon('arrow-up-right')}</a>
      </div>
      <div class="workspace-guide-actions">
        <button type="button" class="btn-secondary" data-workspace-tab="query">查询充值结果</button>
        <button type="button" class="btn-primary" data-workspace-tab="redeem">开始充值</button>
      </div>
    </footer>
  </article>`;
