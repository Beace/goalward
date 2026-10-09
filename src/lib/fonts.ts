export const DEFAULT_UI_FONT = 'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'

// A stored setting is one family name, never a CSS declaration or a family list.
export function normalizeFontFamily(value: unknown): string {
  return typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : ''
}

export function uiFontStack(value: unknown): string {
  const family = normalizeFontFamily(value)
  const quoted = family.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return family ? `"${quoted}", ${DEFAULT_UI_FONT}` : DEFAULT_UI_FONT
}

export const PREVIEW_FONT_FAMILIES = ['Arial', 'Georgia', 'Helvetica Neue', 'Hiragino Sans GB', 'Menlo', 'PingFang SC', 'Times New Roman']
