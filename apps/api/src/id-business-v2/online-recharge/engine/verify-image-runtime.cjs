'use strict';
const { execFileSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const image = process.argv[2] || 'id-online-recharge-engine-local:20261009';
const output = process.argv[3];
const workspace = path.resolve(__dirname, '../../../../../..');
if (
  !output ||
  !path.isAbsolute(output) ||
  !output.startsWith(path.join(workspace, '.runtime') + path.sep)
)
  throw new Error('运行验收输出必须属于当前项目.runtime目录');
const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const container = `id-online-recharge-smoke-${suffix}`;
const volume = `${container}-data`;
const key = randomBytes(32).toString('hex');
function docker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024
    }).trim();
  } catch {
    throw new Error('受控执行器镜像检查失败，请查看此步骤的公开依赖和运行配置');
  }
}
const pythonProbe = `import json,importlib.metadata as m
import torch,cv2,numpy,requests
from PIL import Image
from transformers import CLIPModel,CLIPProcessor
from playwright.sync_api import sync_playwright
gpu=[d.metadata['Name'] for d in m.distributions() if d.metadata['Name'].lower().startswith('nvidia-')]
assert torch.version.cuda is None and not gpu
print(json.dumps({'torchCuda':torch.version.cuda,'nvidiaPackages':gpu,'clipImports':[CLIPModel.__name__,CLIPProcessor.__name__],'versions':{n:m.version(n) for n in ['torch','transformers','opencv-python-headless','numpy','pillow','requests','playwright','pip']}}))`;
const browserProbe = String.raw`
(async()=>{
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {spawnSync}=require('node:child_process');const paths=require('./paths.cjs');const pool=require('./upstream/browser-pool');
assert.ok(process.getuid()>0);let readonly=false;try{fs.writeFileSync('/workspace/engine/__synthetic_readonly_probe.txt','synthetic',{flag:'wx'})}catch(e){readonly=e.code==='EROFS'}assert.ok(readonly);
const root=paths.transientRoot();assert.ok(root.startsWith('/tmp/'));assert.equal(fs.statSync(root).mode&0o777,0o700);
process.env.HEADFUL='1';pool.setRuntimeProfileRoot(root);pool.setRuntimeEnabled(true);pool.setRuntimePoolSize(1);
try{
await pool.initBrowserPool();const slot=await pool.acquireSlot('synthetic-offline-image-check');assert.ok(slot);
const browser=await require('./upstream/node_modules/playwright').chromium.connectOverCDP(slot.cdpUrl);const context=browser.contexts()[0];assert.ok(context);
await context.route('**/*',route=>route.abort());const page=await context.newPage();
await page.setContent('<h1>Synthetic offline runtime</h1>');assert.equal(await page.locator('h1').innerText(),'Synthetic offline runtime');
const version=browser.version();const profile=path.join(root,'browser-pool','slot-0');assert.ok(fs.existsSync(profile));
const py=spawnSync('/opt/solver-venv/bin/python',['-c',
'import json,sys\nfrom playwright.sync_api import sync_playwright\nwith sync_playwright() as p:\n b=p.chromium.connect_over_cdp(sys.argv[1])\n pages=[x for c in b.contexts for x in c.pages]\n assert any(x.locator("h1").count() and x.locator("h1").inner_text()=="Synthetic offline runtime" for x in pages)\n print(json.dumps({"attached":True,"pageCount":len(pages)}))',slot.cdpUrl],{encoding:'utf8',timeout:20000});
assert.equal(py.status,0);const attached=JSON.parse(py.stdout.trim());assert.equal(await page.locator('h1').innerText(),'Synthetic offline runtime');
const diagnostic=path.join(paths.runtimeRoot(),'__synthetic_image_runtime.json');fs.writeFileSync(diagnostic,'{"redacted":true}',{mode:0o600});assert.ok(fs.existsSync(diagnostic));fs.unlinkSync(diagnostic);
await pool.clearTaskContexts(slot.slotId);pool.releaseSlot(slot.slotId);
process.stdout.write('\n__ONLINE_RECHARGE_IMAGE__'+JSON.stringify({uid:process.getuid(),readonlyRoot:readonly,transientMode:448,profileInTmp:true,volumeWritable:true,nodeVersion:process.version,nodePlaywright:require('./upstream/node_modules/playwright/package.json').version,headfulChromium:version,pythonCdp:attached})+'\n');
}finally{await pool.shutdownBrowserPool();paths.clearTransientRoot();assert.equal(fs.existsSync(root),false)}
})().catch(()=>{process.stderr.write('合成离线Chromium运行检查失败。\n');process.exitCode=1});`;
(async () => {
  let createdVolume = false,
    createdContainer = false;
  const report = { image, measuredAt: new Date().toISOString() };
  try {
    const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
    if (
      imageInfo.Os !== 'linux' ||
      imageInfo.Architecture !== 'amd64' ||
      imageInfo.Config.User !== 'node'
    )
      throw new Error('镜像平台或非root用户不符合要求');
    report.imageId = imageInfo.Id;
    report.platform = `${imageInfo.Os}/${imageInfo.Architecture}`;
    report.user = imageInfo.Config.User;
    docker(['volume', 'create', '--label', 'id-online-recharge-smoke=1', volume]);
    createdVolume = true;
    docker([
      'run',
      '-d',
      '--name',
      container,
      '--label',
      'id-online-recharge-smoke=1',
      '--platform=linux/amd64',
      '--network=none',
      '--read-only',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      '--pids-limit=512',
      '--memory=2g',
      '--shm-size=512m',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=512m',
      '--mount',
      `type=volume,source=${volume},target=/workspace/engine/runtime`,
      '--health-interval=1s',
      '--health-start-period=0s',
      '--health-retries=10',
      '-e',
      `ONLINE_RECHARGE_WORKER_KEY=${key}`,
      '-e',
      'ONLINE_RECHARGE_ENGINE_ENABLED=0',
      '-e',
      'HF_HUB_OFFLINE=1',
      '-e',
      'TRANSFORMERS_OFFLINE=1',
      image
    ]);
    createdContainer = true;
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (docker(['inspect', '-f', '{{.State.Health.Status}}', container]) === 'healthy') {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!healthy) throw new Error('执行器私有健康未就绪');
    report.health = JSON.parse(
      docker([
        'exec',
        container,
        'node',
        '-e',
        'require("./healthcheck.cjs").check().then(v=>process.stdout.write(JSON.stringify(v))).catch(()=>process.exit(1))'
      ])
    );
    report.python = JSON.parse(
      docker(['exec', container, '/opt/solver-venv/bin/python', '-c', pythonProbe])
    );
    report.pipCheck = docker(['exec', container, '/opt/solver-venv/bin/pip', 'check']);
    const lockFile = fs.readFileSync(
      path.join(__dirname, 'requirements-hcaptcha.lock.txt'),
      'utf8'
    );
    const locked = lockFile
      .split('\n')
      .filter((line) => line && !line.startsWith('#') && !line.startsWith('--'))
      .sort();
    const resolved = docker(['exec', container, '/opt/solver-venv/bin/pip', 'freeze', '--all'])
      .split('\n')
      .sort();
    if (JSON.stringify(locked) !== JSON.stringify(resolved))
      throw new Error('镜像实际 Python 依赖与独立锁不一致');
    report.pythonLock = {
      packages: locked.length,
      sha256: createHash('sha256').update(lockFile).digest('hex'),
      exactMatch: true
    };
    const browser = docker(['exec', container, 'xvfb-run', '-a', 'node', '-e', browserProbe]);
    report.browser = JSON.parse(browser.split('__ONLINE_RECHARGE_IMAGE__').at(-1).trim());
    const started = Date.now();
    docker(['stop', '--time=30', container]);
    const state = JSON.parse(docker(['inspect', '-f', '{{json .State}}', container]));
    if (![0, 143].includes(state.ExitCode) || state.OOMKilled || Date.now() - started >= 30000)
      throw new Error('容器没有在宽限期内正常退出');
    report.shutdown = {
      exitCode: state.ExitCode,
      durationMs: Date.now() - started,
      oomKilled: state.OOMKilled
    };
    report.externalNetwork = 'disabled';
    report.businessOperations = 'not-executed';
    report.modelWeights = 'not-downloaded';
    report.status = 'PASS';
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (createdContainer) {
      try {
        docker(['rm', '-f', container]);
      } catch {
        /* Keep main error. */
      }
    }
    if (createdVolume) {
      try {
        docker(['volume', 'rm', volume]);
      } catch {
        /* Keep main error. */
      }
    }
  }
})().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
