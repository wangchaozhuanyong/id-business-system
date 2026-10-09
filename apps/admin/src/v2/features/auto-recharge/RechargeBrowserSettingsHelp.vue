<template>
  <AppButton size="small" variant="ghost" @click="open = true">使用说明</AppButton>
  <V2ConfirmDialog
    v-model="open"
    title="代理 IP 与窗口设置使用说明"
    message=""
    width="min(700px, 92vw)"
    :confirm-visible="false"
    cancel-text="知道了"
  >
    <p>同一系统账号共用保存的设置。保存后用于后续新任务，已经执行的任务继续使用原代理与原窗口。</p>
    <ol class="v2-help-steps">
      <li>
        <strong>代理模式与代理 IP：</strong>“动态 IP 提取”显示代理 IP
        管理中的动态提取条目；“固定代理”显示直连条目。下拉只显示启用代理，协议、链接和账号密码均取所选资料。修改代理资料请到代理
        IP 管理，返回后刷新列表。
      </li>
      <li>
        <strong>默认与本次代理：</strong
        >这里保存的默认代理与自动充值共用。开始注册或比特充值时可另选代理，以本次任务的选择为准；只打开登录窗口时使用已保存的默认代理。
      </li>
      <li v-if="!serverMode && !registration">
        <strong>动态代理服务商与重新提取：</strong
        >服务商选项用于匹配提取结果。“每次打开窗口提取”会请求新的出口
        IP；固定代理沿用已保存的主机与端口。
      </li>
      <li v-if="registration">
        <strong>注册代理提取：</strong>注册新建窗口固定重新提取动态
        IP，按通用格式读取；固定代理使用目录中的主机、端口与凭据。继续原任务时沿用原窗口。
      </li>
      <li v-if="!serverMode">
        <strong>IP 查询服务：</strong>读取代理出口的国家和地区，用于跟随 IP
        的语言、时区和定位设置；查询失败应先检查代理及服务连通性。
      </li>
      <li v-if="!serverMode && !registration">
        <strong>每轮等待时间：</strong>设置加载页面和核对账号的等待时间，范围为 1 至 10
        分钟；自动准备至核价总时限为 10 分钟。真人验证保留原窗口供手动处理，不通过换 IP 解决。
      </li>
      <li v-if="registration">
        <strong>注册验证与继续：</strong
        >遇到超时、验证或未知页面时保留原窗口，处理后继续原任务，不自动删除并重建窗口。
      </li>
      <li v-if="!serverMode && !registration">
        <strong>网络恢复次数：</strong>范围为 0 至 9；0 表示不自动恢复，9 表示原窗口最多尝试 10
        次，包含首次。确认网络故障后关闭并重开同一窗口提取
        IP；已有订单只恢复原单核价，付款已发出或结果未知时停止恢复。
      </li>
      <li v-if="!serverMode">
        <strong>窗口分组与标签：</strong
        >刷新读取当前电脑比特浏览器中的现有选项。新窗口加入所选分组并绑定标签，备注使用标签名称；同名选项需先在比特浏览器区分。
      </li>
      <li v-if="!serverMode">
        <strong>本机连接与检测：</strong
        >{{
          directMode
            ? '填写当前电脑的比特接口地址和接口密钥，网页直接连接比特浏览器。'
            : '填写本机服务、比特接口的地址和密钥。本机充值助手与注册执行器分开运行，助手必须允许当前网站来源。'
        }}
        已保存密钥留空会保留；更换电脑或地址后重新填写对应密钥，再刷新分组与标签并检测完整连接。
      </li>
      <li v-if="!serverMode">
        <strong>操作系统、语言与地区：</strong
        >操作系统决定窗口的系统类型。浏览器语言、界面语言、时区和定位可跟随
        IP，也可指定；指定定位需填写经纬度及精度。
      </li>
      <li v-if="!serverMode">
        <strong>同步与建窗规则：</strong>标签页、Cookie 和本地存储同步固定关闭。{{
          registration
            ? '注册新任务创建独立窗口，同一任务继续使用原窗口。'
            : '同一操作人、同一账号复用已有归属记录中的原窗口，首次没有记录时才创建；原窗口被删除时停止。'
        }}其他指纹参数由比特浏览器生成。
      </li>
      <li>
        <strong>保存与失败重试：</strong
        >确认必填资料后保存。失败会保留当前输入，关闭重开也会保留未保存草稿；成功后才更新后续任务使用的设置。
      </li>
    </ol>
  </V2ConfirmDialog>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
defineProps<{ serverMode?: boolean; directMode?: boolean; registration?: boolean }>();
const open = ref(false);
</script>
