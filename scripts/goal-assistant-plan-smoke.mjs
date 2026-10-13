import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const output = 'test-results/goal-assistant-plan'
const base = process.env.GOAL_ASSISTANT_PLAN_SMOKE_URL ?? 'http://127.0.0.1:1420'
const version = Date.now()
await mkdir(output, { recursive: true })
await writeFile(`${output}/vite.config.ts`, `import config from '../../vite.config.ts'\nexport default { ...config, server: { ...config.server, hmr: false } }\n`)
await writeFile(`${output}/harness.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=${version}"></script></body></html>`)
await writeFile(`${output}/harness.tsx`, `
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {GoalsPage} from '/src/components/GoalsPage'
import {applyRuntimeEvent,createInitialState} from '/src/lib/domain'
import {createGoal} from '/src/lib/goals'
import {createGoalAssistantTask,processGoalAssistantRun} from '/src/lib/goal-assistant'
import {captureRunContext} from '/src/lib/workspace'
import {getTraceDisplayEntries} from '/src/lib/trace-calls'
import '/src/index.css'
let sequence=0,runSequence=0,current,request,stopResolve
const initial=createInitialState()
const goal=createGoal({title:'学习直升机驾驶',expected:'取得符合个人兴趣飞行用途的驾驶执照',currentSummary:'零基础；计划在中国学习，预算与时间待确认',criteria:[{text:'取得目标驾驶执照',target:'符合计划用途',method:'核对签发记录'}]})
const task=createGoalAssistantTask(initial.settings,{goalId:goal.id,directory:'/tmp/goal-assistant-plan'})
const seed={...initial,tasks:[task],activeTaskId:task.id,goals:[{...goal,assistant:{taskId:task.id,confirmedVersion:1,input:''}}]}
function frame(payload,kind='stdout'){return {id:'synthetic-'+(++sequence),taskId:task.id,runId:current.id,memberId:task.members[0].id,timestamp:new Date().toISOString(),kind,text:kind==='stdout'?JSON.stringify(payload)+'\\n':''}}
function Harness(){
 const [state,setState]=useState(seed)
 const update=async reducer=>{setState(reducer)}
 const emit=(...payloads)=>{const frames=payloads.map(payload=>frame(payload));setState(value=>frames.reduce(applyRuntimeEvent,value))}
 const raw=(method,params)=>({method,params:{threadId:current.threadId,turnId:current.turnId,...params}})
 const item=(eventType,source)=>({type:'codex.app_server.item',eventType,threadId:current.threadId,turnId:current.turnId,item:source})
 const begin=(phase='plan')=>{
   current={id:'synthetic-plan-'+(++runSequence),threadId:'synthetic-thread-'+runSequence,turnId:'synthetic-turn-'+runSequence,messageId:'synthetic-message-'+runSequence,reasoningId:'synthetic-reasoning-'+runSequence,callId:'synthetic-call-'+runSequence,text:''}
   setState(value=>{
     const goals=value.goals.map(item=>item.id===goal.id?{...item,assistant:{...item.assistant,requestPhase:phase,error:undefined}}:item)
     const contextState={...value,goals}
     const run={id:current.id,prompt:request?.input??'Synthetic follow-up instructions',directory:task.directory,createdAt:new Date(Date.now()-1100).toISOString(),context:captureRunContext(contextState,task),members:[{...task.members[0],runtime:{...initial.settings.runtimes[0],defaultModel:'requested-model'},model:'requested-model',effectiveReasoningEffort:'high',status:'running',sessionId:current.threadId}]}
     return {...contextState,tasks:value.tasks.map(item=>item.id===task.id?{...item,runs:[...item.runs,run]}:item)}
   });request?.resolve();request=undefined
 }
 const ready=()=>emit({type:'codex.app_server.thread_ready',threadId:current.threadId,model:'confirmed-model',modelProvider:'openai',reasoningEffort:'medium'},raw('turn/started',{turn:{id:current.turnId}}))
 const reasonStart=()=>emit(item('item.started',{id:current.reasoningId,type:'reasoning',summary:[],content:['PRIVATE_REASONING_SENTINEL']}),raw('item/reasoning/summaryPartAdded',{itemId:current.reasoningId,summaryIndex:0}),raw('item/reasoning/summaryTextDelta',{itemId:current.reasoningId,summaryIndex:0,delta:'核对公开资料，'}))
 const reasonAppend=()=>emit(raw('item/reasoning/summaryTextDelta',{itemId:current.reasoningId,summaryIndex:0,delta:'再形成任务建议。'}))
 const reasonFinish=()=>emit(item('item.completed',{id:current.reasoningId,type:'reasoning',summary:['核对公开资料，再形成任务建议。'],content:['PRIVATE_REASONING_SENTINEL']}))
 const toolStart=()=>emit(item('item.started',{id:current.callId,type:'mcpToolCall',server:'synthetic-source',tool:'lookup_training',status:'inProgress',arguments:{country:'中国'}}))
 const toolProgress=()=>emit(raw('item/mcpToolCall/progress',{itemId:current.callId,message:'正在读取模拟资料'}))
 const toolFinish=()=>emit(item('item.completed',{id:current.callId,type:'mcpToolCall',server:'synthetic-source',tool:'lookup_training',status:'completed',arguments:{country:'中国'},result:{content:[{type:'text',text:'公开模拟训练要求'}]}}))
 const append=text=>{current.text+=text;emit(raw('item/agentMessage/delta',{itemId:current.messageId,delta:text}))}
 const usage=(output,total)=>emit(raw('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:20,cachedInputTokens:10,outputTokens:output,reasoningOutputTokens:3,totalTokens:20+output},total:{inputTokens:800,outputTokens:total-800,totalTokens:total},modelContextWindow:128000}}))
 const finish=kind=>{
   const frames=kind==='completed'?[frame(item('item.completed',{id:current.messageId,type:'agentMessage',text:current.text})),frame({type:'codex.app_server.turn_completed',threadId:current.threadId,turnId:current.turnId,status:'completed'})]:[]
   frames.push(frame(null,kind));setState(value=>{const next=frames.reduce(applyRuntimeEvent,value);return kind==='completed'?processGoalAssistantRun(next,goal.id,current.id):next});stopResolve?.();stopResolve=undefined
 }
 window.__plan={begin,ready,reasonStart,reasonAppend,reasonFinish,toolStart,toolProgress,toolFinish,append,usage,finish,state,display:()=>getTraceDisplayEntries(state.tasks[0],state.tasks[0].runs.at(-1))}
 return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--background)',color:'var(--foreground)'}}>
  <header style={{height:40,flexShrink:0,display:'flex',alignItems:'center',padding:'0 16px',borderBottom:'1px solid var(--border)',fontSize:12}}>Synthetic Runtime frames · Real GoalsPage / invocation details / trace</header>
  <GoalsPage state={state} selectedGoalId={goal.id} viewRequest={{goalId:goal.id,tab:'tasks',request:1}} onChange={update} onCreateTask={()=>{}} onOpenTask={()=>{}} onOpenAgent={()=>{}} onSendAssistant={async(goalId,input,phase)=>{window.__requests=(window.__requests??0)+1;await new Promise(resolve=>{request={input,phase,resolve}})}} onStopAssistant={async()=>{window.__stops=(window.__stops??0)+1;await new Promise(resolve=>{stopResolve=resolve})}} onPrepareAssistant={async()=>{window.__prepares=(window.__prepares??0)+1}}/>
 </div>
}
createRoot(document.getElementById('root')).render(<Harness/>)
`)

const report = { status: 'running', scope: 'Real GoalsPage Tasks tab, GoalTaskProposals, GoalAssistantRunDetails, MarkdownMessage, shared collapsibles and embedded TracePanel; synthetic correlated Codex native JSONL frames via applyRuntimeEvent. No native Runtime or model inference.', scenarios: [], errors: [] }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) for (const theme of ['light', 'dark']) for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion, locale: 'zh-CN', colorScheme: theme })
    const page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    await page.addInitScript(theme => {
      window.isTauri = true
      document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark') })
    }, theme)
    await page.goto(`${base}/${output}/harness.html?v=${version}`)
    await page.waitForFunction(() => typeof window.__plan?.begin === 'function')
    const section = page.getByRole('region', { name: '下一步任务建议', exact: true })
    const retry = section.getByRole('button', { name: '重新提议', exact: true })
    const details = section.locator('.goal-assistant-run-details')
    const trigger = details.getByRole('button', { name: '调用详情', exact: true })
    const content = details.locator(':scope > [data-slot=collapsible-content]')
    const prefix = `${output}/${width}-${theme}-${reducedMotion}`
    await retry.click()
    await expect(section.getByRole('status')).toHaveText('正在启动任务建议…')
    await expect(details).toHaveCount(0)
    await expect(retry).toBeDisabled()
    await page.evaluate(() => window.__plan.begin())
    await expect(details).toHaveCount(1)
    await expect(details.locator('.goal-run-identity')).toContainText('Codex · requested-model')
    await expect(details.locator('.goal-run-state')).toHaveText('正在启动 Runtime')
    await expect(details.locator('.goal-run-elapsed')).toHaveText(/^\d\d:\d\d$/)
    await expect(details.locator('.goal-run-detail-body')).toHaveCount(0)
    const spinner = details.locator('.goal-run-summary [data-slot=spinner]')
    const animation = await spinner.evaluate(node => getComputedStyle(node).animationName)
    assert.equal(animation, reducedMotion === 'reduce' ? 'none' : 'spin')
    if (reducedMotion === 'no-preference') {
      assert(await spinner.evaluate(node => node.getAnimations().some(animation => animation.playState === 'running')))
      const transform = await spinner.evaluate(node => getComputedStyle(node).transform)
      await expect.poll(() => spinner.evaluate(node => getComputedStyle(node).transform)).not.toBe(transform)
    }
    await page.screenshot({ path: `${prefix}-collapsed.png`, fullPage: true })
    await page.evaluate(() => window.__plan.ready())
    await expect(details.locator('.goal-run-identity')).toContainText('confirmed-model')
    await trigger.focus()
    await trigger.press('Enter')
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(details.locator('.goal-run-invocation .goal-run-metadata')).toContainText('请求模型requested-model')
    await expect(details.locator('.goal-run-invocation .goal-run-metadata')).toContainText('Runtime 确认模型confirmed-model')
    await expect(details.getByText('最近一次 token 用量', { exact: true })).toBeVisible()
    await expect(details.getByText('Runtime 未提供', { exact: true })).toBeVisible()
    await expect(content).toHaveAttribute('data-collapsible-motion', 'idle')
    const instructions = details.getByRole('button', { name: '本轮指令（应用记录）', exact: true })
    await instructions.click()
    await expect(details.locator('.goal-run-instructions pre')).toContainText('请重新提议任务')
    await details.locator('.goal-run-instructions pre').focus()
    await instructions.evaluate(node => node.click())
    await expect(instructions).toBeFocused()
    await expect(instructions).toHaveAttribute('aria-expanded', 'false')

    // Reverse the actual shared spring before it settles; the existing surface
    // remains mounted and the target updates immediately on each activation.
    await trigger.evaluate(node => node.click())
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(content).toHaveAttribute('data-collapsible-motion', 'idle')
    const reversal = await trigger.evaluate(async node => {
      const surface = node.closest('.goal-assistant-run-details').querySelector(':scope > [data-slot=collapsible-content]')
      const values = []
      for (let index = 0; index < 3; index++) {
        node.click()
        await new Promise(resolve => requestAnimationFrame(resolve))
        values.push({ expanded: node.getAttribute('aria-expanded'), height: surface.getBoundingClientRect().height, phase: surface.dataset.collapsibleMotion })
      }
      return values
    })
    assert.deepEqual(reversal.map(value => value.expanded), ['true', 'false', 'true'])
    if (reducedMotion === 'reduce') assert(reversal.every(value => value.phase === 'idle'))
    else assert(reversal.some(value => value.phase === 'animating'))
    await expect(content).toHaveAttribute('data-collapsible-motion', 'idle')
    const response = details.getByLabel('本轮模型回复', { exact: true })
    await page.evaluate(() => { window.__plan.reasonStart(); window.__plan.reasonAppend(); window.__plan.toolStart(); window.__plan.toolProgress(); window.__plan.append('先核对公开训练要求，') })
    await expect(response.locator('.markdown-body')).toHaveText('先核对公开训练要求，')
    await expect(response).not.toContainText('PRIVATE_REASONING_SENTINEL')
    const trace = details.getByLabel('执行检查器', { exact: true })
    const reasonRow = trace.locator('.trace-event[data-reasoning-status]')
    const callRow = trace.locator('.trace-event[data-call-status]')
    const messageRow = trace.locator('.trace-event[data-message-status]')
    await expect(reasonRow).toHaveCount(1)
    await expect(callRow).toHaveCount(1)
    await expect(messageRow).toHaveCount(1)
    await expect(reasonRow).toContainText('核对公开资料，再形成任务建议。')
    await expect(reasonRow).not.toContainText('PRIVATE_REASONING_SENTINEL')
    await reasonRow.evaluate(node => { window.__reasonRow = node })
    await callRow.evaluate(node => { window.__callRow = node })
    await messageRow.evaluate(node => { window.__messageRow = node })
    await response.locator('.markdown-body').evaluate(node => { window.__replyBody = node })
    await page.evaluate(() => { window.__plan.toolProgress(); window.__plan.toolFinish(); window.__plan.reasonFinish(); window.__plan.append('再安排资料与训练路径。'); window.__plan.usage(7, 1100) })
    await expect(response.locator('.markdown-body')).toHaveText('先核对公开训练要求，再安排资料与训练路径。')
    await expect(callRow).toHaveAttribute('data-call-status', 'completed')
    await expect(reasonRow).toHaveAttribute('data-reasoning-status', 'completed')
    assert(await reasonRow.evaluate(node => node === window.__reasonRow))
    assert(await callRow.evaluate(node => node === window.__callRow))
    assert(await messageRow.evaluate(node => node === window.__messageRow))
    const latestUsage = details.locator('.goal-run-usage').filter({ hasText: '最近一次 token 用量' })
    const cumulativeUsage = details.locator('.goal-run-usage').filter({ hasText: '会话累计 token 用量' })
    await expect(latestUsage).toContainText('合计 27')
    await expect(cumulativeUsage).toContainText('合计 1,100')
    await page.evaluate(() => window.__plan.usage(11, 1400))
    await expect(latestUsage).toContainText('合计 31')
    await expect(cumulativeUsage).toContainText('合计 1,400')
    await expect(latestUsage).not.toContainText('1,400')
    await expect(details.getByText('模型上下文窗口')).toContainText('128,000')
    await page.locator('.goal-tabs > .goal-scroll[data-state=active]').evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: `${prefix}-expanded.png`, fullPage: true })

    await page.evaluate(() => window.__plan.append('\n\n' + Array.from({ length: 35 }, (_, index) => '公开模拟计划条目 ' + (index + 1) + '：资料、交付与验收要求。').join('\n\n')))
    await expect(response).toContainText('公开模拟计划条目 35')
    await expect.poll(() => response.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2)
    await response.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })) })
    const jump = details.getByRole('button', { name: '回到最新', exact: true })
    await expect(jump).toBeVisible()
    await response.focus()
    const scrollTop = await response.evaluate(node => node.scrollTop)
    await page.evaluate(() => window.__plan.append('\n\n新收到的公开计划说明。'.repeat(10)))
    assert.equal(await response.evaluate(node => node.scrollTop), scrollTop)
    await expect(response).toBeFocused()
    await jump.click()
    await expect.poll(() => response.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2)
    await expect(jump).toHaveCount(0)
    assert(await response.locator('.markdown-body').evaluate(node => node === window.__replyBody && node.getAnimations({ subtree: true }).length === 0))
    await expect(content).toHaveAttribute('data-collapsible-motion', 'idle')
    const publicText = await response.locator('.markdown-body').innerText()
    const action = { type: 'plan', baseGoalVersion: 1, proposals: [{ id: 'check-requirements', title: '核对训练要求', delivery: '公开要求清单', acceptance: '注明来源和未知', deadline: '', dependsOn: [] }] }
    for (const text of ['\n\n', '`', '`', '`g', 'oal', 'ward\n', JSON.stringify(action), '\n```']) {
      await page.evaluate(text => window.__plan.append(text), text)
      await expect(response.locator('.markdown-body')).toHaveText(publicText)
      assert(await response.locator('.markdown-body').evaluate(node => node === window.__replyBody))
      await expect(response.locator('.markdown-code-block')).toHaveCount(0)
    }
    await details.locator('.goal-run-response-heading').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${prefix}-streaming.png`, fullPage: true })
    await page.evaluate(() => window.__plan.finish('completed'))
    await expect(details.locator('.goal-run-summary [data-slot=spinner]')).toHaveCount(0)
    await expect(section.getByRole('textbox', { name: '任务建议名称：check-requirements', exact: true })).toHaveValue('核对训练要求')
    await expect(response.locator('.markdown-body')).toHaveText(publicText)
    assert(await response.locator('.markdown-body').evaluate(node => node === window.__replyBody))
    await expect(messageRow).toHaveAttribute('data-message-status', 'completed')
    assert(await messageRow.evaluate(node => node === window.__messageRow))
    await callRow.locator('.trace-trigger').click()
    await expect(callRow.locator('.trace-call-output')).toContainText('公开模拟训练要求')
    await callRow.locator('.trace-raw-trigger').click()
    await expect(callRow.locator('.trace-raw-record')).toHaveCount(4)
    await expect(callRow.locator('.trace-raw-records > [data-slot=collapsible-content]')).toHaveAttribute('data-collapsible-motion', 'idle')
    await expect(callRow.locator('.trace-protocol').first()).toContainText('item.started')
    await callRow.locator('.trace-raw-record').first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${prefix}-records.png`, fullPage: true })
    await response.focus()
    await trigger.evaluate(node => node.click())
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    for (const terminal of ['stopped', 'failed']) {
      await retry.click()
      await expect(section.getByRole('status')).toHaveText('正在启动任务建议…')
      await page.evaluate(() => { window.__plan.begin(); window.__plan.ready(); window.__plan.append('保留终止前的公开部分回复。') })
      await expect(details).toHaveCount(1)
      await trigger.click()
      await expect(response).toHaveText('保留终止前的公开部分回复。')
      if (terminal === 'stopped') {
        const stop = details.getByRole('button', { name: '停止生成建议', exact: true })
        await stop.focus(); await stop.press('Enter')
        assert.equal(await page.evaluate(() => window.__stops), 1)
        await expect(details.locator('.goal-run-state')).toHaveText('正在停止…')
      }
      await page.evaluate(terminal => window.__plan.finish(terminal), terminal)
      await expect(details.locator('.goal-run-summary [data-slot=spinner]')).toHaveCount(0)
      await expect(details.getByRole('button', { name: '停止生成建议', exact: true })).toHaveCount(0)
      await expect(response).toHaveText('保留终止前的公开部分回复。')
    }
    await page.evaluate(() => { window.__plan.begin('clarify'); window.__plan.ready() })
    await expect(details).toHaveCount(0)
    await expect(section.getByRole('status')).toHaveText('目标助手正在对话，请等待本轮结束后再整理任务建议。')
    await page.evaluate(() => window.__plan.finish('stopped'))
    await expect(details).toHaveCount(0)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight))
    report.scenarios.push({ width, height, theme, reducedMotion, firstPlanReservedStartingVisible: true, requestedAndConfirmedModelsVisible: true, elapsedClockVisible: true, actualSpinnerAnimation: animation, sharedDisclosureAnimatedOrStaticAsPreferred: true, rapidReversal: reversal, nestedInstructionFocusRestored: true, outerDisclosureFocusRestored: true, oneReasoningToolAndMessageRow: true, stableGroupedRowsDuringUpdates: true, publicReasoningSummaryVisible: true, privateReasoningAbsentFromProse: true, distinctLatestReportedAndCumulativeTokenUsage: true, stablePublicReplyDOMBeforeAndAfterCompletion: true, splitInternalJSONHidden: true, noTokenEntranceAnimation: true, manualScrollPreserved: true, jumpToLatestWorks: true, completedRecordInspectable: true, failedAndStoppedRemoveSpinnerKeepReply: true, keyboardStopImmediate: true, newerClarificationHidesOlderPlanningDetails: true, noViewportOverflow: true })
    await context.close()
  }
  assert.deepEqual(report.errors, [])
  report.status = 'passed'
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.status = 'failed'; report.failure = error.stack ?? String(error); throw error
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
