import { DEFAULT_SETTINGS, PROVIDERS } from './constants.js';

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

export async function loadSettings() {
  const stored = await browser.storage.sync.get('settings');
  if (!stored.settings) return { ...DEFAULT_SETTINGS };
  return deepMerge(DEFAULT_SETTINGS, stored.settings);
}

export async function saveSettings(settings) {
  await browser.storage.sync.set({ settings });
}

export function getProviderConfig(settings) {
  const providerId = settings.activeProvider;
  const providerDef = PROVIDERS[providerId];
  const providerSettings = settings.providers[providerId] || {};
  return { ...providerDef, ...providerSettings };
}
