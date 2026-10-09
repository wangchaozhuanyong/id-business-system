<template>
  <fieldset>
    <legend>系统、语言与地区</legend>
    <el-form-item label="浏览器内核版本" prop="browserOptions.coreVersion" required>
      <el-input
        v-model="options.coreVersion"
        inputmode="numeric"
        maxlength="3"
        aria-label="浏览器内核版本"
      />
      <p class="recharge-settings-hint">
        默认 152；请使用当前比特浏览器中已安装的版本，更新客户端后可修改。浏览器标识随内核生成。
      </p>
    </el-form-item>
    <el-form-item label="操作系统">
      <el-select v-model="options.os" aria-label="选择操作系统">
        <el-option label="苹果电脑（macOS）" value="MacIntel" />
        <el-option label="Windows 电脑" value="Win32" />
        <el-option label="Linux 电脑" value="Linux x86_64" />
      </el-select>
    </el-form-item>
    <el-form-item
      v-if="options.os === 'Win32'"
      label="Windows 版本"
      prop="browserOptions.osVersion"
      required
    >
      <el-select v-model="options.osVersion" aria-label="Windows 版本">
        <el-option label="Windows 11" value="11" />
        <el-option label="Windows 10" value="10" />
      </el-select>
    </el-form-item>
    <el-form-item label="窗口宽度（像素）" prop="browserOptions.openWidth" required>
      <el-input-number
        v-model="options.openWidth"
        :min="800"
        :max="7680"
        :precision="0"
        aria-label="窗口宽度"
      />
    </el-form-item>
    <el-form-item label="窗口高度（像素）" prop="browserOptions.openHeight" required>
      <el-input-number
        v-model="options.openHeight"
        :min="600"
        :max="4320"
        :precision="0"
        aria-label="窗口高度"
      />
    </el-form-item>
    <el-form-item label="浏览器语言来源">
      <el-switch
        v-model="options.languageFromIp"
        aria-label="浏览器语言跟随 IP"
        active-text="跟随 IP"
        inactive-text="指定语言"
      />
    </el-form-item>
    <el-form-item v-if="!options.languageFromIp" label="浏览器语言">
      <el-select v-model="options.language" aria-label="选择浏览器语言">
        <el-option
          v-for="item in languages"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="界面语言来源">
      <el-switch
        v-model="options.displayLanguageFromIp"
        aria-label="界面语言跟随 IP"
        active-text="跟随 IP"
        inactive-text="指定语言"
      />
    </el-form-item>
    <el-form-item v-if="!options.displayLanguageFromIp" label="浏览器界面语言">
      <el-select v-model="options.displayLanguage" aria-label="选择浏览器界面语言">
        <el-option
          v-for="item in languages"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="时区来源">
      <el-switch
        v-model="options.timezoneFromIp"
        aria-label="时区跟随 IP"
        active-text="跟随 IP"
        inactive-text="指定时区"
      />
    </el-form-item>
    <el-form-item
      v-if="!options.timezoneFromIp"
      label="指定时区"
      prop="browserOptions.timezone"
      required
    >
      <el-select
        v-model="options.timezone"
        filterable
        allow-create
        default-first-option
        aria-label="指定时区"
      >
        <el-option
          v-for="item in timezones"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
      <p class="recharge-settings-hint">可搜索常用时区，或输入完整时区名称，如 Asia/Shanghai。</p>
    </el-form-item>
    <el-form-item label="定位来源">
      <el-switch
        v-model="options.positionFromIp"
        aria-label="定位跟随 IP"
        active-text="跟随 IP"
        inactive-text="指定经纬度"
      />
    </el-form-item>
    <template v-if="!options.positionFromIp">
      <el-form-item label="纬度" prop="browserOptions.latitude" required>
        <el-input-number
          v-model="options.latitude"
          :min="-90"
          :max="90"
          :precision="6"
          aria-label="定位纬度"
        />
      </el-form-item>
      <el-form-item label="经度" prop="browserOptions.longitude" required>
        <el-input-number
          v-model="options.longitude"
          :min="-180"
          :max="180"
          :precision="6"
          aria-label="定位经度"
        />
      </el-form-item>
      <el-form-item label="定位精度（米）" prop="browserOptions.accuracy" required>
        <el-input-number v-model="options.accuracy" :min="1" :max="100000" aria-label="定位精度" />
      </el-form-item>
    </template>
  </fieldset>
  <fieldset>
    <legend>同步选项</legend>
    <p class="recharge-settings-note">
      为保护账号登录态，标签页、Cookie、本地存储、数据库和授权信息同步固定关闭。
    </p>
    <el-form-item label="标签页同步">
      <el-switch
        :model-value="false"
        disabled
        aria-label="标签页同步"
        active-text="开启"
        inactive-text="关闭"
      />
    </el-form-item>
    <el-form-item label="Cookie 同步">
      <el-switch
        :model-value="false"
        disabled
        aria-label="Cookie 同步"
        active-text="开启"
        inactive-text="关闭"
      />
    </el-form-item>
    <el-form-item label="本地存储同步">
      <el-switch
        :model-value="false"
        disabled
        aria-label="本地存储同步"
        active-text="开启"
        inactive-text="关闭"
      />
    </el-form-item>
  </fieldset>
  <fieldset>
    <legend>系统建窗规则</legend>
    <dl class="recharge-settings-list">
      <div>
        <dt>设备类型</dt>
        <dd>电脑</dd>
      </div>
      <div>
        <dt>登录网址</dt>
        <dd>ChatGPT 官网</dd>
      </div>
      <div>
        <dt>保存密码弹窗</dt>
        <dd>关闭</dd>
      </div>
      <div>
        <dt>初始登录资料</dt>
        <dd>
          {{
            registration
              ? '使用本次选中的授权邮箱及注册资料，继续任务时保留原窗口'
              : '已有会话先核对实际账号；首次登录使用本次授权 JSON 或账号库资料'
          }}
        </dd>
      </div>
      <div>
        <dt>窗口创建与打开</dt>
        <dd>
          {{
            registration
              ? '每笔注册任务创建独立窗口；排队打开'
              : '同操作人、同账号复用原窗口；首次无记录才创建；排队打开'
          }}
        </dd>
      </div>
      <div>
        <dt>其他指纹参数</dt>
        <dd>由比特浏览器生成</dd>
      </div>
    </dl>
  </fieldset>
</template>
<script setup lang="ts">
import { watch } from 'vue';
import type { V2RechargeBrowserOptions } from './contracts';
import { rechargeLanguages as languages } from './recharge-browser-presentation';
const options = defineModel<V2RechargeBrowserOptions>({ required: true });
watch(
  () => options.value.os,
  (os) => {
    if (os !== 'Win32') options.value.osVersion = '';
    else if (options.value.osVersion !== '10' && options.value.osVersion !== '11')
      options.value.osVersion = '11';
  }
);
defineProps<{ registration?: boolean }>();
const timezones = [
  { label: '中国 · 上海', value: 'Asia/Shanghai' },
  { label: '新加坡', value: 'Asia/Singapore' },
  { label: '日本 · 东京', value: 'Asia/Tokyo' },
  { label: '美国 · 洛杉矶', value: 'America/Los_Angeles' },
  { label: '美国 · 纽约', value: 'America/New_York' },
  { label: '英国 · 伦敦', value: 'Europe/London' },
  { label: '协调世界时', value: 'UTC' }
];
</script>
<style scoped src="./recharge-browser-settings.css"></style>
