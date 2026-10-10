import { Check, CircleAlert, Download, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { useI18n } from '@/i18n'
import { openExternalUrl } from '@/lib/bridge'
import { notify } from '@/components/ui/sonner'
import type { AppUpdateController } from '@/hooks/use-app-update'

function bytes(value: number) {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`
}

export function AppUpdateSettings({ update, activeCount, unsaved, tasksBusy = false }: { update: AppUpdateController; activeCount: number; unsaved: boolean; tasksBusy?: boolean }) {
  const { t, language } = useI18n()
  const busy = ['checking', 'downloading', 'installing', 'restarting'].includes(update.phase)
  const blocked = activeCount > 0 || tasksBusy || unsaved
  const progress = update.totalBytes ? Math.min(100, update.downloadedBytes / update.totalBytes * 100) : undefined
  const checkedAt = update.checkedAt ? new Date(update.checkedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US') : undefined
  const status = {
    idle: t('尚未检查', 'Not checked yet'), checking: t('正在检查更新…', 'Checking for updates…'),
    current: t('未发现可安装的更新', 'No installable update found'), available: t('有新版本可用', 'Update available'),
    downloading: t('正在下载并验证更新…', 'Downloading and verifying update…'), downloaded: t('更新已下载并通过签名验证', 'Update downloaded and signature verified'),
    installing: t('正在安装更新…', 'Installing update…'), installed: t('更新已安装，重启后生效', 'Update installed; restart to use it'),
    restarting: t('正在重启…', 'Restarting…'),
  }[update.phase]
  const checkable = ['idle', 'current', 'available'].includes(update.phase)
  return <section className="space-y-5" aria-label={t('应用更新', 'App updates')}>
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
      <h1 className="text-[13px] font-semibold">{t('应用更新', 'App updates')}</h1>
      <Button variant="outline" size="sm" disabled={!update.desktop || !checkable || busy} onClick={() => void update.check()}>
        {update.phase === 'checking' ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}{t('检查更新', 'Check for updates')}
      </Button>
    </div>
    <dl className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-xs">
      <dt className="text-muted-foreground">{t('当前版本', 'Current version')}</dt><dd className="font-mono">{update.info.currentVersion}</dd>
      <dt className="text-muted-foreground">{t('可用版本', 'Available version')}</dt><dd className="font-mono">{update.info.version || '—'}</dd>
      <dt className="text-muted-foreground">{t('检查方式', 'Update checks')}</dt><dd>{t('启动后及每 6 小时自动检查', 'Automatically at startup and every 6 hours')}</dd>
      {checkedAt && <><dt className="text-muted-foreground">{t('上次成功检查', 'Last successful check')}</dt><dd><time dateTime={update.checkedAt}>{checkedAt}</time></dd></>}
    </dl>
    {!update.desktop ? <p role="status" className="text-xs leading-5 text-muted-foreground">{t('浏览器提供界面预览；请在 macOS 桌面应用中检查和安装更新。', 'This browser is a UI preview. Check and install updates in the macOS desktop app.')}</p> : <>
      <div className="space-y-3 rounded-md border border-border p-3">
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs">{update.error ? <CircleAlert className="size-3.5 text-destructive" /> : busy ? <Spinner className="size-3.5" /> : ['current', 'downloaded', 'installed'].includes(update.phase) ? <Check className="size-3.5 text-status-success" /> : null}{update.error ? t('操作未完成，请重试', 'The operation did not complete. Retry to continue.') : status}</p>
        {update.phase === 'downloading' && <div className="space-y-2">
          {progress !== undefined && <Progress value={progress} aria-label={t('更新下载进度', 'Update download progress')} />}
          <p className="text-[11px] text-muted-foreground">{bytes(update.downloadedBytes)}{update.totalBytes ? ` / ${bytes(update.totalBytes)} · ${Math.floor(progress ?? 0)}%` : t(' 已下载 · 总大小未知', ' downloaded · Total size unknown')}</p>
        </div>}
        {update.error && <p role="alert" className="break-words text-xs leading-5 text-destructive">{update.error.message}</p>}
        <div className="flex flex-wrap gap-2">
          {update.phase === 'available' && <Button size="sm" onClick={() => void update.download()}><Download className="size-3.5" />{update.error?.stage === 'download' ? t('重试下载', 'Retry download') : t('下载更新', 'Download update')}</Button>}
          {(update.phase === 'downloaded' || update.phase === 'installing') && <Button size="sm" disabled={busy || blocked} onClick={() => void update.install()}>{update.phase === 'installing' ? <Spinner className="size-3.5" /> : <Download className="size-3.5" />}{update.error?.stage === 'install' ? t('重试安装', 'Retry install') : t('安装更新', 'Install update')}</Button>}
          {(update.phase === 'installed' || update.phase === 'restarting') && <Button size="sm" disabled={busy || blocked} onClick={() => void update.restart()}>{update.phase === 'restarting' ? <Spinner className="size-3.5" /> : <RotateCcw className="size-3.5" />}{update.error?.stage === 'restart' ? t('重试重启', 'Retry restart') : t('重启并使用新版本', 'Restart and use update')}</Button>}
          {update.info.releaseUrl && <Button variant="ghost" size="sm" onClick={() => void openExternalUrl(update.info.releaseUrl!).catch(error => notify.error(t('无法打开版本页面：', 'Could not open release page: ') + String(error).replace(/^Error: /, '')))}><ExternalLink className="size-3.5" />{t('查看 GitHub Release', 'View GitHub Release')}</Button>}
        </div>
        {(['downloaded', 'installed', 'installing', 'restarting'].includes(update.phase)) && <p className="text-[11px] leading-5 text-muted-foreground">{activeCount > 0 ? t(`请等待 ${activeCount} 个执行实例结束后再安装或重启。`, `Wait for ${activeCount} active instances to finish before installing or restarting.`) : tasksBusy ? t('请等待任务编排结束后再安装或重启。', 'Wait for task orchestration to finish before installing or restarting.') : unsaved ? t('请先保存或还原设置更改，并等待本地数据保存完成。', 'Save or restore settings changes and wait for local data to finish saving.') : t('安装后需要手动重启，更新不会自动重启应用。', 'Restart manually after installation. Updates do not restart the app automatically.')}</p>}
      </div>
      {update.info.notes && <div className="space-y-2"><h2 className="text-xs font-medium">{t('版本说明', 'Release notes')}</h2><p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">{update.info.notes}</p></div>}
      <p className="text-[11px] leading-5 text-muted-foreground">{t('更新来自 Goalward 的 GitHub Release，下载后验证发布签名。当前 macOS 包仍为临时签名，未经 Apple 公证。', 'Updates come from Goalward GitHub Releases; the release signature is verified after download. macOS packages currently use ad hoc signing and are not notarized by Apple.')}</p>
    </>}
  </section>
}
