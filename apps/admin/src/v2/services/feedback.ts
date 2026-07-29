import { ElMessage } from '@/v2/services/elementPlusMessage';

export function showV2Warning(message: string) {
  ElMessage.warning(message);
}
