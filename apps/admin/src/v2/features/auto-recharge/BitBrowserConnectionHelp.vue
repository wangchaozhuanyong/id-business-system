<template>
  <AppButton variant="ghost" @click="open = true">连接说明</AppButton>
  <V2ConfirmDialog
    v-model="open"
    title="比特浏览器直连说明"
    message=""
    width="min(640px, 92vw)"
    :confirm-visible="false"
    cancel-text="知道了"
  >
    <p>“仅登录窗口”由网页直接连接当前电脑的比特浏览器，无需安装本系统的本机连接器。</p>
    <ol class="v2-help-steps">
      <li>
        <strong>开启本地接口：</strong>在当前电脑安装、启动并登录比特浏览器，进入“系统设置 → Local
        API（本地接口）”，确认接口已启用。子账号需由主账号授予接口权限。
      </li>
      <li>
        <strong>获取地址和密钥：</strong>在同一页面开启“鉴权控制”，查看本地接口地址和 API
        Token（接口密钥）。使用当前页面显示的值，不要沿用另一台电脑的配置。
      </li>
      <li>
        <strong>填写网站设置：</strong
        >回到这里，把地址填入“比特接口地址”，把密钥填入“比特接口密钥”。密钥加密保存；已有配置留空会保留，更换电脑时填写新值。
      </li>
      <li>
        <strong>允许本机网络访问：</strong>网站请求访问本机网络时选择“允许”；此前拒绝过，可点击
        Chrome 地址栏左侧的网站设置，允许本地网络访问，再刷新本页。若显示“回环网络访问”，也需允许。
      </li>
      <li>
        <strong>检测并保存：</strong
        >刷新分组与标签并选择有效选项，点击“检测完整连接”，通过后保存设置，再选择 ChatGPT
        账号并打开登录窗口。
      </li>
    </ol>
    <p>
      同一系统账号共用已保存的接口配置。更换电脑后请重新核对密钥并检测连接；两台电脑的配置不同，切回原电脑时也需要核对。
    </p>
    <p>
      登录过程中请保留当前管理页面。关闭、刷新或切换页面会停止网页自动操作，已打开的比特窗口保留供手动处理。真人验证仍需在官网窗口完成。
    </p>
    <a
      href="https://www.bitbrowser.cn/news/how-to-configure-bitbrowser-mcp"
      target="_blank"
      rel="noopener noreferrer"
      >查看比特浏览器官方接口设置说明</a
    >
  </V2ConfirmDialog>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
const open = ref(false);
</script>
