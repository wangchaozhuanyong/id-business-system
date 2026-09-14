<template>
  <fieldset>
    <legend>系统、语言与地区</legend>
    <el-form-item label="操作系统">
      <el-select v-model="options.os" aria-label="选择操作系统">
        <el-option label="苹果电脑（macOS）" value="MacIntel" />
        <el-option label="Windows 电脑" value="Win32" />
        <el-option label="Linux 电脑" value="Linux x86_64" />
      </el-select>
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
        <dd>不预填账号、密码或 Cookie，随后从本次授权 JSON 恢复登录</dd>
      </div>
      <div>
        <dt>窗口创建与打开</dt>
        <dd>每笔任务创建独立窗口；排队打开</dd>
      </div>
      <div>
        <dt>其他指纹参数</dt>
        <dd>由比特浏览器生成</dd>
      </div>
    </dl>
  </fieldset>
</template>
<script setup lang="ts">
import type { V2RechargeBrowserOptions } from './contracts';
import { rechargeLanguages as languages } from './recharge-browser-presentation';
const options = defineModel<V2RechargeBrowserOptions>({ required: true });
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
