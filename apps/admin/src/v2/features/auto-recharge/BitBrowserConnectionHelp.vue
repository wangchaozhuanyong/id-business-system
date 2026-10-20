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
    <p>
      自动充值与仅登录均由网页直连当前电脑的比特浏览器，无需安装额外充值助手；支持已开启本地接口的
      Windows 与 Mac 电脑。
    </p>
    <ol class="v2-help-steps">
      <li>
        <strong>使用安全网站地址：</strong>请通过 HTTPS 安全连接打开管理网站；不安全的 HTTP
        公网地址无法执行网页直连。
      </li>
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
        账号并执行充值或打开登录窗口。
      </li>
    </ol>
    <p>
      在页面“当前比特连接”选择本机配置，或点击“新增比特连接”。每台电脑在当前会话独立选择；刷新或重新登录后需重新核对和检测，不跟随其他电脑的选择。新连接可先只保存地址与密钥，补全本账号的分组、标签和代理后才能执行。网站选择配置不会切换比特客户端的登录账号，子账号需由主账号授予接口及分组权限。运行中的任务继续使用启动时的连接，历史原单需回到对应连接复查。
    </p>
    <p>
      执行过程中请保留当前管理页面。关闭、刷新或切换页面会停止自动操作，已打开的比特窗口保留。付款提交后断线只复查原单，不重复付款；真人与银行验证在官网窗口完成。
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
