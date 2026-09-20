import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerUsageExtension } from './extension.mjs';

export default function usageExtension(pi: ExtensionAPI) {
  registerUsageExtension(pi);
}
