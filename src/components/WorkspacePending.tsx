import type { RefObject } from 'react'
import { Plus, Search, Target } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'
import { GoalListLayout } from './GoalListLayout'
import './goals.css'

/** Keep the destination's geometry while the first workspace read is pending.
 * Unknown data is never presented as an empty workspace or a zero count.
 * Frequent navigation stays immediate; no artificial minimum loading duration.
 */
export function WorkspacePending({ page, error, goalListWidth }: {
  page: string; error: string; goalListWidth: RefObject<number>
}) {
  const status = <div className="px-2 py-3 text-xs text-muted-foreground" role={error ? 'alert' : 'status'}>
    {error || (page === 'goals' ? '正在读取目标…' : '正在读取本地数据…')}
    {error && <p className="mt-2">数据文件已保留。请检查应用存储目录和文件权限后重新打开。</p>}
  </div>
  if (page !== 'goals') return <section className="min-w-0 flex-1 p-4" aria-label="工作区内容">{status}</section>
  return <div className="goals-page">
    <GoalListLayout rememberedWidth={goalListWidth} navigation={<aside className="goal-picker" aria-label="目标列表" aria-busy={!error}>
      <div className="goal-picker-heading"><span><Target size={15} />目标</span><Button size="icon-sm" variant="ghost" aria-label="创建目标" disabled><Plus size={16} /></Button></div>
      <div className="goal-search"><Search size={14} /><Input aria-label="搜索目标" placeholder="搜索目标…" disabled /></div>
      <div className="goal-picker-list">{status}</div>
      <div className="goal-picker-footer">目标与现状持续保存<br />执行按任务组织</div>
    </aside>}>
      <main className="goal-detail" aria-label="目标详情" aria-busy={!error}>
        <div className="goal-header" aria-hidden="true">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="my-3 h-5 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </main>
    </GoalListLayout>
  </div>
}
