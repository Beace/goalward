import type { Settings } from './types'

export const appearanceKeys = ['theme', 'fontFamily', 'language'] as const
export type AppearancePreferences = Pick<Settings, typeof appearanceKeys[number]>
export type AppearancePatch = Partial<AppearancePreferences>

export function appearancePreferences(settings: Settings): AppearancePreferences {
  return { theme: settings.theme, fontFamily: settings.fontFamily, language: settings.language }
}

export function configurationSettings(settings: Settings) {
  const { theme: _theme, fontFamily: _font, language: _language, ...configuration } = settings
  return configuration
}
