import {
  Atom, File, FileArchive, FileAudio, FileCode2, FileCog, FileImage,
  FileJson, FileSpreadsheet, FileTerminal, FileText, FileType, FileVideo,
  Globe, Paintbrush, createLucideIcon, type LucideIcon,
} from 'lucide-react'
import { useI18n } from '@/i18n'

const Markdown = createLucideIcon('Markdown', [
  ['rect', { x: 2, y: 5, width: 20, height: 14, rx: 2, key: 'frame' }],
  ['path', { d: 'M5 15V9l3 3 3-3v6M17 9v6m-3-3 3 3 3-3', key: 'mark' }],
])

// Presentation only: an icon never implies that this file can be previewed.
type IconTone = 'orange' | 'blue' | 'purple' | 'cyan' | 'yellow' | 'green' | 'red' | 'muted'
const formats: { extensions: string[]; icon: LucideIcon; label: string; tone: IconTone }[] = [
  { extensions: ['html', 'htm'], icon: FileCode2, label: 'HTML', tone: 'orange' },
  { extensions: ['md', 'markdown', 'mdown', 'mdx'], icon: Markdown, label: 'Markdown', tone: 'blue' },
  { extensions: ['css', 'scss', 'sass', 'less'], icon: Paintbrush, label: '样式文件', tone: 'purple' },
  { extensions: ['jsx', 'tsx'], icon: Atom, label: 'React', tone: 'cyan' },
  { extensions: ['js', 'mjs', 'cjs'], icon: FileCode2, label: 'JavaScript', tone: 'yellow' },
  { extensions: ['ts', 'mts', 'cts'], icon: FileCode2, label: 'TypeScript', tone: 'blue' },
  { extensions: ['py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'swift', 'kt', 'rb', 'php', 'vue', 'svelte'], icon: FileCode2, label: '代码文件', tone: 'blue' },
  { extensions: ['json', 'jsonc', 'jsonl'], icon: FileJson, label: 'JSON', tone: 'yellow' },
  { extensions: ['yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'env', 'xml'], icon: FileCog, label: '配置文件', tone: 'blue' },
  { extensions: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'], icon: FileTerminal, label: '脚本', tone: 'green' },
  { extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp', 'heic'], icon: FileImage, label: '图片', tone: 'purple' },
  { extensions: ['csv', 'tsv', 'xls', 'xlsx', 'ods'], icon: FileSpreadsheet, label: '表格', tone: 'green' },
  { extensions: ['pdf'], icon: FileType, label: 'PDF', tone: 'red' },
  { extensions: ['txt', 'log', 'rtf', 'doc', 'docx', 'odt'], icon: FileText, label: '文档', tone: 'muted' },
  { extensions: ['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'bz2', 'xz'], icon: FileArchive, label: '压缩文件', tone: 'orange' },
  { extensions: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'], icon: FileAudio, label: '音频', tone: 'purple' },
  { extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'], icon: FileVideo, label: '视频', tone: 'red' },
]
const englishLabels: Record<string, string> = {
  样式文件: 'Stylesheet', 代码文件: 'Code file', 配置文件: 'Configuration file', 脚本: 'Script',
  图片: 'Image', 表格: 'Spreadsheet', 文档: 'Document', 压缩文件: 'Archive', 音频: 'Audio', 视频: 'Video',
}

export function FileIcon({ name, kind }: { name: string; kind?: string }) {
  const { t } = useI18n()
  const filename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  const extension = filename.includes('.') ? filename.split('.').at(-1) : ''
  const format = formats.find(format => format.extensions.includes(extension ?? ''))
    ?? (kind === 'html' ? formats[0] : kind === 'markdown' ? formats[1] : undefined)
  const Icon = kind === 'web' ? Globe : format?.icon ?? File
  const label = kind === 'web' ? t('网页', 'Web page') : format?.label ? t(format.label, englishLabels[format.label] ?? format.label) : t('文件', 'File')
  return <span className="file-type-icon" data-tone={kind === 'web' ? 'cyan' : format?.tone ?? 'muted'} title={label} aria-hidden="true"><Icon size={16} strokeWidth={1.5}/></span>
}
