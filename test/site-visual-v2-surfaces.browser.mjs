// Offline acceptance of shared surfaces, standalone entries, and control states.
// Every request is fulfilled locally; no listener, database, payment or external request is started.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {root, origin, interceptDesign, settle, separatorSnapshot, toggleDesignTheme} from './helpers/offline-design.mjs';
import {fixture, actor, clock} from './helpers/site-visual-v2-fixtures.mjs';
const output=path.join(root,'docs/design/site-visual-v2-20261113/surfaces');
await mkdir(output,{recursive:true});
const browser=await chromium.launch();
const controlsOnly=process.argv.includes('--controls-only');
const evidence=controlsOnly ? {...JSON.parse(await readFile(path.join(output,'checks.json'),'utf8')),contrast:[],scenes:JSON.parse(await readFile(path.join(output,'checks.json'),'utf8')).scenes.filter(x=>x.name!=='control-states')} : {synthetic:true,scenes:[],errors:[],external:[],missing:[],writes:[],contrast:[]};
const routes=['overview','mailboxes/google','customers/new','customers/list','settings/costs','settings/exchange-rates','settings/monitoring','plugins/mailboxes','data','recharge/start','online-recharge/chatgpt','workspace/recharge-codes'];
const capture=async(page,name,width,theme)=>{
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
  await settle(page);
  const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme}));
  assert.equal(geometry.theme,theme);
  const spacing=await separatorSnapshot(page, await page.locator('#main').count() ? '#main' : 'body');
  const file=`${name}-${width}-${theme}.png`;
  await page.screenshot({path:path.join(output,file),animations:'disabled'});
  const findings=[...(geometry.scroll>width+1?['document overflow']:[]),...spacing.findings];
  evidence.scenes.push({name,width,theme,file,geometry,spacing});
  console.log(JSON.stringify({file,findings}));
};
try {
  for(const width of (controlsOnly?[]:[1440,390,320])) for(const theme of ['light','dark']) {
    const context=await browser.newContext({viewport:{width,height:width>900?1000:844},reducedMotion:'reduce',serviceWorkers:'block',locale:'zh-CN'});
    const requests=await interceptDesign(context,{localFixtures:fixture,actor});
    context.on('request',r=>{if(!['GET','HEAD'].includes(r.method()) && !r.url().includes('/api/local/changes')) evidence.writes.push({url:r.url(),method:r.method()});});
    const page=await context.newPage();page.setDefaultTimeout(8000);await page.clock.setFixedTime(clock);
    page.on('pageerror',e=>evidence.errors.push(e.message));
    for(const route of routes) {
      await page.goto(origin+'/#/'+route);
      await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
      if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme) await toggleDesignTheme(page);
      if(['recharge/start','online-recharge/chatgpt'].includes(route)) await page.waitForTimeout(350);
      await capture(page,route.replaceAll('/','-'),width,theme);
    }
    await page.goto(origin+'/mailbox-query');
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await capture(page,'public-mailbox',width,theme);
    assert(await page.locator('.public-mailbox-brand img').evaluate(n=>n.complete && n.naturalWidth>0),'Public brand asset decoded under CSP');
    await page.goto(origin+'/integrations/bitbrowser/local-login');
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await capture(page,'bitbrowser-standalone',width,theme);
    // Only the existing login markup and display assets are injected, exactly as the host normally serves them.
    await context.route(origin+'/api/local/auth/session',route=>route.fulfill({json:{configured:true,actor:null}}));
    await context.route(origin+'/?visual-login=1',async route=>{
      const source=(await readFile(path.join(root,'frontend/index.html'),'utf8'))
        .replace('<head>','<head><meta name="id-local-auth" content="required">')
        .replace('    <script src="./prototype.js','<link rel="stylesheet" href="/local-auth.css"><script src="/local-auth.js" defer></script><script src="/local-data.js" defer></script>\n    <script src="./prototype.js');
      return route.fulfill({contentType:'text/html',body:source});
    });
    await page.goto(origin+'/?visual-login=1');
    await page.locator('#local-auth-gate').waitFor();
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByLabel('登录邮箱',{exact:true}).fill('preview@example.test');
    await page.locator('#local-auth-password').fill('synthetic-preview-only');
    await capture(page,'login',width,theme);
    assert(await page.locator('.local-auth-mark').evaluate(n=>n.complete && n.naturalWidth>0),'Brand asset decoded');
    assert((await page.locator('#local-auth-password').boundingBox()).height>=44);
    evidence.external.push(...requests.external); evidence.missing.push(...requests.unavailable);
    await context.close();
  }
  // Control-state and contrast evidence at both widths and themes, without submitting a form.
  for(const width of [1920,320]) for(const theme of ['light','dark']) {
    const ctx=await browser.newContext({viewport:{width,height:1080},reducedMotion:'reduce'});
    await interceptDesign(ctx,{localFixtures:fixture,actor,skipRechargeAssets:true});
    const page=await ctx.newPage(); await page.goto(origin+'/#/workspace/order/gpt');
    await page.locator('#commerce-email').waitFor();
    if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme) await toggleDesignTheme(page);
    await page.evaluate(()=>{
      const A=window.IDDesignAPI;
      A.openDrawer('控件状态与长标签验收','离线合成资料。',
        A.field('正常输入','qa-normal',A.input('qa-normal','已填写的正常文本'),true,'键盘可打开的字段说明。')+
        A.field('只读资料','qa-readonly',A.input('qa-readonly','只读内容','readonly'))+
        A.field('暂不可编辑','qa-disabled',A.input('qa-disabled','禁用内容','disabled'))+
        A.field('这是一个用于验证手机布局的较长字段名称','qa-invalid',A.input('qa-invalid','待更正内容','aria-invalid="true"'),true,'长标签说明。')+
        A.field('等待输入','qa-empty',A.input('qa-empty','','placeholder="请输入内容"')));
      A.setError('qa-invalid','请核对后重试，输入内容会保留。');
    });
    const input=page.locator('#qa-normal');await input.focus();await input.hover();
    const contrast=await page.evaluate(()=>{
      const rgb=s=>(s.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
      const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const ratio=(a,b)=>(Math.max(lum(rgb(a)),lum(rgb(b)))+.05)/(Math.min(lum(rgb(a)),lum(rgb(b)))+.05);
      const normal=getComputedStyle(document.getElementById('qa-normal'));
      const idle=getComputedStyle(document.getElementById('qa-empty'));
      const label=getComputedStyle(document.querySelector('label[for="qa-normal"]'));
      const panel=getComputedStyle(document.querySelector('#drawer'));
      return {text:ratio(normal.color,normal.backgroundColor),label:ratio(label.color,panel.backgroundColor),focus:ratio(normal.borderColor,normal.backgroundColor),restingBorder:ratio(idle.borderBottomColor,idle.backgroundColor)};
    });
    evidence.contrast.push({width,theme,...contrast});
    assert(contrast.text>=4.5 && contrast.label>=4.5 && contrast.focus>=3 && contrast.restingBorder>=3,JSON.stringify(contrast));
    await page.screenshot({path:path.join(output,`controls-focused-${width}-${theme}.png`),animations:'disabled'});
    const before=await input.boundingBox();
    await page.locator('#drawer .field-title-help summary').first().click();
    assert.deepEqual(await input.boundingBox(),before,'Help must not move the control');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#drawer .field-title-help[open]').count(),0);
    await capture(page,'control-states',width,theme);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await ctx.close();
  }
} finally {await browser.close();await writeFile(path.join(output,'checks.json'),JSON.stringify(evidence,null,2));}
assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.external,[]);assert.deepEqual(evidence.missing,[]);assert.deepEqual(evidence.writes,[]);
assert.equal(evidence.scenes.filter(x=>x.geometry.scroll>x.width+1 || x.spacing.findings.length).length,0,'Surface geometry checks');
console.log(`PASS ${evidence.scenes.length} scenes; no external requests or writes`);
