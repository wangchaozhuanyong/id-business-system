<template>
  <V2AsyncRegion
    :phase="query.phase.value"
    :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
    skeleton="form"
    loading-title="正在读取执行电脑"
    @retry="query.refresh"
  >
    <section class="online-panel">
      <V2SectionHeading title="执行电脑"
        ><template #actions
          ><AppButton variant="ghost" allow-when-stale @click="query.refresh"
            >刷新状态</AppButton
          ></template
        ></V2SectionHeading
      >
      <p>
        Mac 和 Windows 都可绑定。首次设置后台启动后，日常只需在网站提交充值、确认付款和查看结果。
      </p>
      <p>
        在下方“指定执行电脑”选择本次使用的电脑并保存配置。切换只影响新任务，同时只执行一笔充值。
      </p>
      <p v-if="!query.data.value?.items.length">尚未绑定执行电脑。</p>
      <el-form
        v-if="canManage"
        :model="draft.form"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
        @submit.prevent="pair()"
      >
        <el-form-item label="新增电脑名称" required
          ><el-input
            v-model="draft.form.name"
            maxlength="80"
            placeholder="例如：办公室 Mac／Windows 充值电脑"
        /></el-form-item>
        <AppButton variant="soft" :loading="busy" @click="pair()">生成电脑配对文件</AppButton>
      </el-form>
      <template v-if="pairing">
        <p>
          本次配对：{{ pairingName }}。文件仅可使用一次，10 分钟内有效；请在对应电脑完成首次设置。
        </p>
        <AppButton variant="soft" @click="download">下载本次配对文件</AppButton>
      </template>
      <template v-if="canManage">
        <p>
          首次设置：先在电脑安装原充值助手，再下载对应设置入口，解压后双击。选择助手所在文件夹与本台电脑的配对文件；之后登录电脑时自动后台运行。
        </p>
        <el-space wrap>
          <AppButton variant="soft" @click="downloadBackgroundSetup('mac')"
            >下载 Mac 一次性设置入口</AppButton
          >
          <AppButton variant="soft" @click="downloadBackgroundSetup('windows')"
            >下载 Windows 一次性设置入口</AppButton
          >
        </el-space>
      </template>
      <p>电脑休眠、离线或比特未就绪时，分配给它的任务继续排队。关闭网站页面不影响后台助手。</p>
      <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
    </section>
    <section v-for="device in query.data.value?.items ?? []" :key="device.id" class="online-panel">
      <V2SectionHeading :title="device.name" />
      <p class="online-wrap">{{ device.name }} · {{ deviceStatus(device) }}</p>
      <p v-if="device.activeTask" class="online-wrap">当前任务：{{ device.activeTask.id }}</p>
      <p v-if="!device.paired">尚未完成配对，请下载配对文件并在这台电脑完成一次性设置。</p>
      <el-space v-if="canManage" wrap>
        <AppButton
          variant="soft"
          @click="
            connectionDevice = device;
            connectionOpen = true;
          "
          >比特接口设置</AppButton
        >
        <AppButton variant="ghost" :disabled="busy" @click="pair(device)">重新配对</AppButton>
        <AppButton
          v-if="device.enabled"
          variant="danger"
          :disabled="busy"
          @click="
            revokeDevice = device;
            revokeOpen = true;
          "
          >停用这台电脑</AppButton
        >
      </el-space>
    </section>
    <OnlineBitbrowserConnectionDrawer
      v-model="connectionOpen"
      :device="connectionDevice"
      @saved="changed"
    />
    <V2ConfirmDialog
      v-model="revokeOpen"
      title="停用执行电脑"
      :message="`停用${revokeDevice?.name || '所选电脑'}后不再领取新任务；进行中的任务若无法回传，将保留原单等待核对。`"
      :confirm-loading="busy"
      danger
      @confirm="revoke"
    />
  </V2AsyncRegion>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import OnlineBitbrowserConnectionDrawer from './OnlineBitbrowserConnectionDrawer.vue';
import { canUseOnlineAction } from './permissions';
import { bitbrowserApi, type BitbrowserPairing, type BitbrowserDevice } from './bitbrowser-api';
import { downloadBackgroundSetup } from './bitbrowser-background-setup';
import { downloadOnlineText } from './api';
const emit = defineEmits<{ updated: []; 'devices-loaded': [BitbrowserDevice[]] }>();
const auth = useAuthStore();
const canManage = computed(() => canUseOnlineAction(auth.user, 'config', 'update'));
const query = useV2ModuleQuery({
  moduleKey: 'online-recharge-config',
  scope: 'online-recharge',
  key: 'bitbrowser-devices',
  trackRouteData: false,
  getRevalidateAt: () => Date.now() + 10000,
  query: ({ signal }) => bitbrowserApi.devices(signal)
});
watch(query.data, (data) => emit('devices-loaded', data?.items ?? []), { immediate: true });
const draft = useV2FormDraft('online-recharge/bitbrowser-device', () => ({ name: '' }));
draft.open('new-device', { name: '' });
const busy = ref(false),
  revokeOpen = ref(false),
  message = ref(''),
  failed = ref(false),
  pairingName = ref('');
const pairing = ref<BitbrowserPairing | null>(null);
const revokeDevice = ref<BitbrowserDevice | null>(null),
  connectionDevice = ref<BitbrowserDevice | null>(null),
  connectionOpen = ref(false);
const deviceStatus = (device: BitbrowserDevice) =>
  !device.enabled
    ? device.pairingExpiresAt
      ? '尚未配对'
      : '已停用'
    : !device.paired
      ? '尚未配对'
      : !device.online
        ? '离线，任务继续排队'
        : device.busy
          ? '正在执行任务'
          : !device.ready
            ? '比特浏览器未就绪'
            : '在线，可领取任务';
let active = true;
const clear = () => {
  pairing.value = null;
  pairingName.value = '';
  message.value = '';
  connectionOpen.value = false;
  revokeOpen.value = false;
};
const stopIdentity = sessionCoordinator.subscribeIdentityChange(clear);
onBeforeUnmount(() => {
  active = false;
  clear();
  stopIdentity();
});
async function changed() {
  await query.refresh();
  emit('updated');
}
async function pair(device?: BitbrowserDevice) {
  if (busy.value || !canManage.value) return;
  const name = device?.name || draft.form.name.trim();
  if (!name) {
    failed.value = true;
    message.value = '请填写电脑名称';
    return;
  }
  const finish = device ? undefined : draft.beginSave(),
    epoch = sessionCoordinator.identityEpoch.value;
  busy.value = true;
  try {
    const result = await bitbrowserApi.pair(name, device?.id);
    if (!active || epoch !== sessionCoordinator.identityEpoch.value) return;
    pairing.value = result;
    pairingName.value = name;
    finish?.();
    failed.value = false;
    message.value = '配对文件已就绪，请在对应电脑完成一次性后台设置';
    await changed();
  } catch (error) {
    if (active && epoch === sessionCoordinator.identityEpoch.value) {
      failed.value = true;
      message.value = getApiErrorMessage(error);
    }
  } finally {
    if (active) busy.value = false;
  }
}
function download() {
  if (!pairing.value) return;
  downloadOnlineText(
    JSON.stringify({ serverUrl: window.location.origin, pairingToken: pairing.value.pairingToken }),
    'online-bitbrowser-pairing.json',
    'application/json'
  );
}
async function revoke() {
  if (busy.value || !canManage.value || !revokeDevice.value) return;
  const id = revokeDevice.value.id,
    epoch = sessionCoordinator.identityEpoch.value;
  busy.value = true;
  try {
    await bitbrowserApi.revoke(id);
    if (!active || epoch !== sessionCoordinator.identityEpoch.value) return;
    clear();
    await changed();
  } catch (error) {
    if (active && epoch === sessionCoordinator.identityEpoch.value) {
      failed.value = true;
      message.value = getApiErrorMessage(error);
    }
  } finally {
    if (active) busy.value = false;
  }
}
</script>
