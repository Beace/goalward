import type { RefObject } from 'react'
import { Plus, Search, Target } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'
import { GoalListLayout } from './GoalListLayout'
import { useI18n } from '@/i18n'
import './goals.css'

/** Keep the destination's geometry while the first workspace read is pending.
 * Unknown data is never presented as an empty workspace or a zero count.
 * Frequent navigation stays immediate; no artificial minimum loading duration.
 */
export function WorkspacePending({ page, error, goalListWidth }: {
  page: string; error: string; goalListWidth: RefObject<number>
}) {
  const { t } = useI18n()
  const status = <div className="px-2 py-3 text-xs text-muted-foreground" role={error ? 'alert' : 'status'}>
    {error || (page === 'goals' ? t('正在读取目标…', 'Loading goals…') : t('正在读取本地数据…', 'Loading local data…'))}
    {error && <p className="mt-2">{t('数据文件已保留。请检查应用存储目录和文件权限后重新打开。', 'The data file has been preserved. Check the app storage directory and file permissions, then reopen the app.')}</p>}
  </div>
  if (page !== 'goals') return <section className="min-w-0 flex-1 p-4" aria-label={t('工作区内容', 'Workspace content')}>{status}</section>
  return <div className="goals-page">
    <GoalListLayout rememberedWidth={goalListWidth} navigation={<aside className="goal-picker" aria-label={t('目标列表', 'Goal list')} aria-busy={!error}>
      <div className="goal-picker-heading"><span><Target size={15} />{t('目标', 'Goals')}</span><Button size="icon-sm" variant="ghost" aria-label={t('创建目标', 'Create goal')} disabled><Plus size={16} /></Button></div>
      <div className="goal-search"><Search size={14} /><Input aria-label={t('搜索目标', 'Search goals')} placeholder={t('搜索目标…', 'Search goals…')} disabled /></div>
      <div className="goal-picker-list">{status}</div>
      <div className="goal-picker-footer">{t('目标与现状持续保存', 'Goals and context are saved')}<br />{t('执行按任务组织', 'Runs are organized by task')}</div>
    </aside>}>
      <main className="goal-detail" aria-label={t('目标详情', 'Goal details')} aria-busy={!error}>
        <div className="goal-header" aria-hidden="true">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="my-3 h-5 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </main>
    </GoalListLayout>
  </div>
}
