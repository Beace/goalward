import type { Settings } from './types'

export const appearanceKeys = ['theme', 'fontFamily', 'language', 'backgroundImage', 'backgroundImageOpacity', 'backgroundSurfaceOpacity'] as const
export type AppearancePreferences = Pick<Settings, typeof appearanceKeys[number]>
export type AppearancePatch = Partial<AppearancePreferences>

export function appearancePreferences(settings: Settings): AppearancePreferences {
  return {
    theme: settings.theme, fontFamily: settings.fontFamily, language: settings.language,
    backgroundImage: settings.backgroundImage,
    backgroundImageOpacity: settings.backgroundImageOpacity,
    backgroundSurfaceOpacity: settings.backgroundSurfaceOpacity,
  }
}

export function configurationSettings(settings: Settings) {
  const {
    theme: _theme, fontFamily: _font, language: _language,
    backgroundImage: _background, backgroundImageOpacity: _imageOpacity, backgroundSurfaceOpacity: _surfaceOpacity,
    ...configuration
  } = settings
  return configuration
}
