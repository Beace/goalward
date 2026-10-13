// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createInitialState } from './lib/domain'
import { createGoal } from './lib/goals'
import { createWorkspaceTask } from './lib/workspace'
import type { AppState, RuntimeEvent, StartRequest } from './lib/types'
import type { ExecutionStep } from './lib/task-types'
const bridge=vi.hoisted(()=>({isDesktop: true, activeRuntimeTurns: vi.fn(async () => []),loadState:vi.fn(),saveState:vi.fn(),loadTraceEvents:vi.fn(),onRuntimeEvent:vi.fn(),discoverLocalEnvironment:vi.fn(),chooseDirectory:vi.fn(),chooseFile:vi.fn(),exportTask:vi.fn(),startRun:vi.fn(),stopRun:vi.fn(),probeRuntime:vi.fn(),storageInfo:vi.fn()}))
vi.mock('@/lib/bridge',()=>bridge)
vi.mock('@/components/Workbench',()=>({Workbench:({operations,onStop,onSend}:{operations:React.ReactNode;onStop:()=>void;onSend:(prompt:string,recipient:string)=>Promise<void>})=><><button onClick={onStop}>Stop all runs</button><button onClick={()=>void onSend('User instruction','all').catch(()=>{})}>Send directly</button>{operations}</>}))
vi.mock('@/components/TracePanel',()=>({TracePanel:()=>null}))
vi.mock('@/components/ui/resizable',()=>({ResizablePanelGroup:({children}:{children:React.ReactNode})=><div>{children}</div>,ResizablePanel:({children}:{children:React.ReactNode})=><div>{children}</div>,ResizableHandle:()=>null}))
let stored:AppState,emit:(event:RuntimeEvent)=>void
function step(id:string,deps:string[]=[]):ExecutionStep{return {id,title:id,instructions:`Execute ${id}`,memberIds:[stored.tasks[0].members[0].id],dependsOn:deps,kind:'agent',expectedOutput:'Check records',failurePolicy:'halt',status:'pending'}}
beforeEach(()=>{
 vi.resetAllMocks();stored=createInitialState();stored.settings.maxParallel=1
 const goal=createGoal({title:'Deliver the app',expected:'Pass checks',currentSummary:'Not verified yet'});stored.goals=[goal]
 stored.tasks=[createWorkspaceTask(stored.settings,{title:'Orchestration test task',directory:'/tmp',goalId:goal.id,acceptance:'Individual checks pass'})];stored.activeTaskId=stored.tasks[0].id
 stored.tasks[0].members[0].instructions='Work only within the assigned role'
 stored.onboarding={version:1,completedAt:new Date().toISOString(),outcome:'configured'}
 bridge.loadState.mockImplementation(async()=>structuredClone(stored));bridge.saveState.mockImplementation(async(value:AppState)=>{stored=structuredClone(value)});bridge.loadTraceEvents.mockResolvedValue([]);bridge.onRuntimeEvent.mockImplementation(async(callback:typeof emit)=>{emit=callback;return()=>{}});bridge.startRun.mockResolvedValue(undefined);bridge.stopRun.mockResolvedValue(undefined)
})
afterEach(cleanup)
async function mount(){
 render(<App/>)
 const navigation=await screen.findByRole('navigation',{name:'工作空间导航'})
 fireEvent.click(await within(navigation).findByRole('button',{name:/Orchestration test task/}))
 fireEvent.click(await screen.findByRole('button',{name:'执行编排'}))
}
async function terminal(index:number,kind:'completed'|'failed'|'stopped'='completed') {const request:StartRequest=bridge.startRun.mock.calls[index][0];await act(async()=>emit({id:crypto.randomUUID(),taskId:request.taskId,runId:request.runId,memberId:request.memberId,timestamp:new Date().toISOString(),kind,text:'terminal',exitCode:kind==='completed'?0:1}))}
describe('explicit orchestration and immutable execution context',()=>{
 it('enforces dependency confirmation, capacity and context snapshots before dispatch',async()=>{
  stored.tasks[0].plan=[step('Inspect'),step('Review',['Inspect'])]
  await mount();fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(1))
  expect(stored.tasks[0].runs[0].context?.goal?.currentState.summary).toBe('Not verified yet')
  expect(bridge.startRun.mock.calls[0][0].prompt).toContain('Work only within the assigned role')
  expect(bridge.startRun.mock.calls[0][0].prompt).toContain('Individual checks pass')
  await terminal(0)
  expect(stored.tasks[0].businessStatus).toBe('in_progress');expect(stored.goals[0].currentState.summary).toBe('Not verified yet')
  expect(bridge.startRun).toHaveBeenCalledTimes(1)
  fireEvent.change(await screen.findByRole('textbox',{name:'步骤结果 Inspect'}),{target:{value:'Startup check passed and records were saved'}})
  await waitFor(()=>expect((screen.getByRole('button',{name:'确认'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:'确认'}))
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(2))
  expect(bridge.startRun.mock.calls[1][0].prompt).toContain('Startup check passed and records were saved')
  await terminal(1)
  expect(stored.tasks[0].plan?.map(s=>s.status)).toEqual(['done','review'])
  expect(stored.tasks[0].results??[]).toEqual([])
 })
 it('holds independent steps at the global limit and stopping does not dispatch pending steps',async()=>{
  stored.tasks[0].plan=[step('Inspect'),step('Independent inspection')]
  await mount();fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button',{name:'停止编排'}))
  await waitFor(()=>expect(bridge.stopRun).toHaveBeenCalledWith(stored.tasks[0].runs[0].id))
  await terminal(0,'stopped')
  expect(stored.tasks[0].orchestration).toBe('stopped');expect(bridge.startRun).toHaveBeenCalledTimes(1)
  expect(stored.tasks[0].plan?.[1].status).toBe('pending')
 })
 it('waits for an occupied native member even when global capacity allows another independent step',async()=>{
  stored.settings.maxParallel=2
  stored.tasks[0].plan=[step('First turn'),step('Second turn in the same session')]
  await mount();fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(1))
  // Settled metadata renders trigger another dispatcher pass before the first
  // native turn has finished; this must retain the second step as pending.
  await act(async()=>{await Promise.resolve()})
  expect(bridge.startRun).toHaveBeenCalledTimes(1)
  expect(stored.tasks[0].plan?.[1].status).toBe('pending')
  await terminal(0)
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(2))
  expect(stored.tasks[0].orchestration).toBe('running')
  expect(stored.tasks[0].runs[0].members[0].status).toBe('completed')
  expect(stored.tasks[0].runs[1].members[0].status).toBe('running')
 })
 it('sends native cancellation even when the state file cannot be written',async()=>{
  stored.tasks[0].plan=[step('Inspect')]
  await mount();fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(1))
  bridge.saveState.mockRejectedValue(new Error('disk unavailable'))
  fireEvent.click(screen.getByRole('button',{name:'停止编排'}))
  await waitFor(()=>expect(bridge.stopRun).toHaveBeenCalledTimes(1))
  expect(bridge.stopRun).toHaveBeenCalledWith(stored.tasks[0].runs[0].id)
 })
 it('does not dispatch after activation persistence fails even if later writes succeed',async()=>{
  stored.tasks[0].plan=[step('Inspect')]
  await mount()
  let failed=false
  bridge.saveState.mockImplementation(async(value:AppState)=>{if(!failed&&value.tasks[0].orchestration==='running'){failed=true;throw new Error('one-off disk error')}stored=structuredClone(value)})
  fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await screen.findAllByText(/one-off disk error/)
  await waitFor(()=>expect(stored.tasks[0].orchestration).toBe('stopped'))
  expect(bridge.startRun).not.toHaveBeenCalled()
 })
 it('rolls back an unsaved confirmation and cannot dispatch its successor',async()=>{
  stored.tasks[0].plan=[step('Inspect'),step('Successor',['Inspect'])]
  await mount();fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await waitFor(()=>expect(bridge.startRun).toHaveBeenCalledTimes(1));await terminal(0)
  fireEvent.change(await screen.findByRole('textbox',{name:'步骤结果 Inspect'}),{target:{value:'Inspection evidence'}})
  await waitFor(()=>expect(stored.tasks[0].plan?.[0].output).toBe('Inspection evidence'))
  let failed=false
  bridge.saveState.mockImplementation(async(value:AppState)=>{if(!failed&&value.tasks[0].plan?.[0].status==='done'){failed=true;throw new Error('confirmation disk error')}stored=structuredClone(value)})
  fireEvent.click(screen.getByRole('button',{name:'确认'}))
  await screen.findAllByText(/confirmation disk error/)
  await waitFor(()=>expect(stored.tasks[0].orchestration).toBe('stopped'))
  expect(stored.tasks[0].plan?.[0].status).toBe('review')
  expect(bridge.startRun).toHaveBeenCalledTimes(1)
 })
 it('records a failed launch and halts successors rather than leaving a phantom running step',async()=>{
  stored.tasks[0].plan=[step('Failed step'),step('Follow-up',['Failed step'])];bridge.startRun.mockRejectedValue(new Error('runtime unavailable'))
  await mount();fireEvent.click(screen.getByRole('button',{name:'启动编排'}))
  await waitFor(()=>expect(stored.tasks[0].plan?.[0].status).toBe('failed'))
  expect(stored.tasks[0].runs[0].members[0].status).toBe('failed');expect(bridge.startRun).toHaveBeenCalledTimes(1)
  expect(stored.tasks[0].plan?.[1].status).toBe('pending')
 })
})
