import 'element-plus/es/components/message/style/css.mjs';
import { messageConfig } from 'element-plus/es/components/config-provider/src/config-provider.mjs';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';

Object.assign(messageConfig, {
  duration: 2600,
  grouping: true,
  max: 2,
  offset: 16,
  placement: 'top-right',
  showClose: true
});

export { ElMessage };
