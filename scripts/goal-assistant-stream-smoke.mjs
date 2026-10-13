import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'

const output = 'test-results/goal-assistant-stream'
const base = process.env.GOAL_ASSISTANT_SMOKE_URL ?? 'http://127.0.0.1:1420'
const harnessVersion = Date.now()
await mkdir(output, { recursive: true })
await writeFile(`${output}/vite.config.ts`, `import config from '../../vite.config.ts'\nexport default { ...config, server: { ...config.server, hmr: false } }\n`)
await writeFile(`${output}/harness.html`, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./harness.tsx?v=${harnessVersion}"></script></body></html>`)
await writeFile(`${output}/harness.tsx`, `
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {GoalAssistant} from '/src/components/GoalAssistant'
import {applyRuntimeEvent,createInitialState} from '/src/lib/domain'
import {createGoal} from '/src/lib/goals'
import {createGoalAssistantTask} from '/src/lib/goal-assistant'
import '/src/index.css'
let sequence=0,runSequence=0,currentRun,request,stopRequest
const initial=createInitialState()
const goal=createGoal({title:'I want to fly; how do I get started?',expected:'Obtain a helicopter license for recreational flying in China',currentSummary:'Beginner; budget and time remain unclear',criteria:[{text:'Obtain the intended pilot license',method:'Check issuance records',target:'Supports the planned use'}]})
const task=createGoalAssistantTask(initial.settings,{goalId:goal.id,directory:'/tmp/goal-assistant-stream'})
const seed={...initial,tasks:[task],activeTaskId:task.id,goals:[{...goal,assistant:{taskId:task.id,input:'',requestPhase:'clarify'}}]}
const event=(payload,kind='stdout')=>({id:'event-'+(++sequence),taskId:task.id,runId:currentRun.id,memberId:task.members[0].id,timestamp:new Date(Date.parse(task.createdAt)+sequence*4).toISOString(),kind,text:kind==='stdout'?JSON.stringify(payload)+'\\n':''})
const stream=payload=>event({type:'stream_event',event:payload,session_id:'session-'+runSequence,parent_tool_use_id:null})
function Harness(){
 const [state,setState]=useState(seed)
 const update=async reducer=>{setState(reducer)}
 const begin=(adapter='codex')=>{
   const runtime={...initial.settings.runtimes.find(item=>item.adapter===adapter),id:adapter,enabled:true}
   currentRun={id:'run-'+(++runSequence),adapter,text:'',messageId:'message-'+runSequence}
   const run={id:currentRun.id,createdAt:new Date(Date.parse(task.createdAt)+sequence*4).toISOString(),prompt:request?.input??'Next turn',directory:task.directory,members:[{...task.members[0],runtime,model:'',status:'running'}]}
   setState(value=>({...value,tasks:value.tasks.map(item=>item.id===task.id?{...item,runs:[...item.runs,run],messages:[...item.messages,{id:'user-'+runSequence,role:'user',runId:run.id,createdAt:run.createdAt,text:run.prompt}]}:item)}))
   request?.resolve();request=undefined
 }
 const append=text=>{
   currentRun.text+=text
   const frame=currentRun.adapter==='claude'?stream({type:'content_block_delta',index:0,delta:{type:'text_delta',text}}):event({method:'item/agentMessage/delta',params:{threadId:'thread-'+runSequence,turnId:'turn-'+runSequence,itemId:currentRun.messageId,delta:text}})
   setState(value=>applyRuntimeEvent(value,frame))
 }
 const startText=()=>{
   const frames=currentRun.adapter==='claude'?[stream({type:'message_start',message:{id:currentRun.messageId,role:'assistant',content:[]}}),stream({type:'content_block_start',index:0,content_block:{type:'text',text:''}})]:[event({type:'turn.started'}),event({type:'item.started',item:{id:currentRun.messageId,type:'agent_message',text:''}})]
   setState(value=>frames.reduce(applyRuntimeEvent,value))
 }
 const finish=kind=>{
   const frames=kind==='completed'?(currentRun.adapter==='claude'?[stream({type:'content_block_stop',index:0}),stream({type:'message_stop'}),event({type:'assistant',message:{id:currentRun.messageId,content:[{type:'text',text:currentRun.text}]},session_id:'session-'+runSequence}),event({type:'result',subtype:'success',result:currentRun.text})]:[event({type:'item.completed',item:{id:currentRun.messageId,type:'agent_message',text:currentRun.text}}),event({type:'turn.completed'})]):[]
   frames.push(event(null,kind));setState(value=>frames.reduce(applyRuntimeEvent,value));stopRequest?.();stopRequest=undefined
 }
 window.__goalHarness={begin,startText,append,finish,state,stopCalls:window.__stopCalls??0,sendCalls:window.__sendCalls??0}
 return <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--background)',color:'var(--foreground)'}}>
   <header style={{height:44,flexShrink:0,display:'flex',alignItems:'center',padding:'0 20px',borderBottom:'1px solid var(--border)',fontSize:13}}>Goalward · Goal assistant streaming interaction verification</header>
   <div style={{flex:1,minHeight:0,containerType:'inline-size',containerName:'goal-detail'}}><GoalAssistant state={state} goal={state.goals[0]} onChange={update} onStart={async()=>{}} onSend={async(goalId,input)=>{window.__sendCalls=(window.__sendCalls??0)+1;await new Promise(resolve=>{request={input,resolve}})}} onStop={async()=>{window.__stopCalls=(window.__stopCalls??0)+1;window.__stopCalledAt=performance.now();await new Promise(resolve=>{stopRequest=resolve})}} onConfirm={async()=>{}}/></div>
 </div>
}
createRoot(document.getElementById('root')).render(<Harness/>)
`)

const report = {
  status: 'running',
  scope: 'Real GoalAssistant, MarkdownMessage, shared Spinner and CSS in isolated browser state. Synthetic raw Codex app-server JSONL deltas and Claude deltas use applyRuntimeEvent; no native process or model inference.',
  scenarios: [],
  errors: [],
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [width, height] of [[1536, 960], [1280, 720]]) {
    for (const theme of ['light', 'dark']) {
      for (const reducedMotion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion, locale: 'zh-CN', colorScheme: theme })
        const page = await context.newPage()
        page.on('pageerror', error => report.errors.push(error.message))
        await page.addInitScript(theme => {
          // Enable desktop-gated UI handlers only. This harness never invokes native APIs.
          window.isTauri = true
          document.addEventListener('DOMContentLoaded', () => {
            document.documentElement.dataset.theme = theme
            document.documentElement.classList.toggle('dark', theme === 'dark')
          })
        }, theme)
        await page.goto(`${base}/${output}/harness.html?v=${harnessVersion}`)
        await page.waitForFunction(() => typeof window.__goalHarness?.append === 'function')
        const transcript = page.locator('.goal-assistant-transcript')
        const pending = page.locator('.goal-assistant-pending-status')
        const spinner = pending.locator('[data-slot=spinner]')
        const input = page.getByRole('textbox', { name: '给目标助手的消息', exact: true })
        const send = page.getByRole('button', { name: '发送给目标助手', exact: true })
        const assistantMessages = page.locator('.goal-assistant-message-assistant')
        const prefix = `${output}/${width}-${theme}-${reducedMotion}`
        await input.fill('Beginner, interested in recreational flying in China')
        await input.press('Control+Enter')
        await expect(pending).toHaveText('正在连接目标助手…')
        await expect(assistantMessages).toHaveCount(0)
        await expect(send).toBeDisabled()
        await page.evaluate(() => window.__goalHarness.begin())
        await expect(pending).toHaveText('正在思考…')
        await expect(assistantMessages).toHaveCount(0)
        await expect(page.getByRole('button', { name: '停止目标助手', exact: true })).toBeEnabled()
        const spinnerStyle = await spinner.evaluate(node => ({ name: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration, transform: getComputedStyle(node).transform }))
        if (reducedMotion === 'reduce') {
          assert.equal(spinnerStyle.name, 'none')
          assert.equal(await spinner.evaluate(node => node.getAnimations().length), 0)
        } else {
          assert.notEqual(spinnerStyle.name, 'none')
          assert(await spinner.evaluate(node => node.getAnimations().some(animation => animation.playState === 'running')))
          await expect.poll(() => spinner.evaluate(node => getComputedStyle(node).transform)).not.toBe(spinnerStyle.transform)
        }
        await page.screenshot({ path: `${prefix}-waiting.png`, fullPage: true })
        await page.evaluate(() => { window.__goalHarness.startText(); window.__goalHarness.append('First clarify ') })
        const article = assistantMessages.last()
        await expect(article.locator('.markdown-body')).toHaveText('First clarify ')
        await expect(pending).toHaveText('正在回复…')
        await article.evaluate(node => { window.__streamArticle = node; window.__streamBody = node.querySelector('.markdown-body') })
        await input.focus()
        for (const chunk of ['success criteria, ', 'then determine the training path.']) {
          await page.evaluate(text => window.__goalHarness.append(text), chunk)
          assert(await article.evaluate(node => node === window.__streamArticle && node.querySelector('.markdown-body') === window.__streamBody))
          await expect(input).toBeFocused()
        }
        await expect(article.locator('.markdown-body')).toHaveText('First clarify success criteria, then determine the training path.')
        assert(await page.evaluate(() => window.__goalHarness.state.tasks[0].runs.at(-1).members[0].status === 'running'))
        assert(await article.evaluate(node => node.getAnimations({ subtree: true }).length === 0))
        const action = '\n\n```goalward\n{"type":"clarify","baseGoalVersion":1,"draft":null}\n```'
        for (const character of action) {
          await page.evaluate(text => window.__goalHarness.append(text), character)
          await expect(article.locator('.markdown-body')).toHaveText('First clarify success criteria, then determine the training path.')
          await expect(article).not.toContainText('goalward')
          await expect(article.locator('.markdown-code-block')).toHaveCount(0)
        }
        await page.screenshot({ path: `${prefix}-streaming.png`, fullPage: true })
        await page.evaluate(() => window.__goalHarness.finish('completed'))
        await expect(pending).toHaveCount(0)
        await expect(assistantMessages).toHaveCount(1)
        await expect(article.locator('.markdown-body')).toHaveText('First clarify success criteria, then determine the training path.')
        assert(await article.evaluate(node => node === window.__streamArticle))

        // Repeat turns quickly: a fresh waiting row belongs to the current run,
        // and each completed turn retains exactly one message in history.
        for (const [index, adapter, terminal] of [[2, 'claude', 'failed'], [3, 'codex', 'stopped'], [4, 'codex', 'completed']]) {
          await input.fill(`Additional turn ${index}`)
          await send.click()
          await expect(pending).toHaveText('正在连接目标助手…')
          await page.evaluate(adapter => window.__goalHarness.begin(adapter), adapter)
          await expect(pending).toHaveText('正在思考…')
          await page.evaluate(index => { window.__goalHarness.startText(); window.__goalHarness.append(`Reply for turn ${index}`); window.__goalHarness.append('Still visible in real time.') }, index)
          await expect(pending).toHaveText('正在回复…')
          await expect(assistantMessages).toHaveCount(index)
          await expect(assistantMessages.last()).toContainText(`Reply for turn ${index}Still visible in real time.`)
          if (terminal === 'stopped') {
            const stop = page.getByRole('button', { name: '停止目标助手', exact: true })
            await stop.focus()
            await page.evaluate(() => window.__goalHarness.append('Continue streaming before keyboard stop.'))
            await expect(stop).toBeFocused()
            await stop.press('Enter')
            assert.equal(await page.evaluate(() => window.__stopCalls), 1)
            await input.focus()
            await page.evaluate(() => window.__goalHarness.append('Content received before the stop acknowledgement.'))
            await expect(input).toBeFocused()
          }
          await page.evaluate(terminal => window.__goalHarness.finish(terminal), terminal)
          await expect(pending).toHaveCount(0)
          await expect(assistantMessages).toHaveCount(index)
          await expect(assistantMessages.last()).toContainText(`Reply for turn ${index}Still visible in real time.`)
          if (terminal === 'failed') await expect(page.locator('.goal-assistant-error')).toContainText('上次运行失败')
          else if (terminal === 'stopped') await expect(page.locator('.goal-assistant-error')).toContainText('上次运行已停止')
          else await expect(page.locator('.goal-assistant-error')).toHaveCount(0)
        }

        // Overflow the transcript and then inspect history while more text arrives.
        await input.fill('Expand the training plan')
        await send.click()
        await page.evaluate(() => { window.__goalHarness.begin(); window.__goalHarness.startText(); window.__goalHarness.append(Array.from({ length: 50 }, (_, index) => 'Training plan item ' + (index + 1) + ': check requirements, confirm material, and record the next step.').join('\n\n')) })
        await expect(assistantMessages.last()).toContainText('Training plan item 50')
        await expect(input).toHaveValue('')
        await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(500)
        await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2)
        await transcript.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })) })
        const jump = page.getByRole('button', { name: '回到最新', exact: true })
        await expect(jump).toBeVisible()
        const previousScroll = await transcript.evaluate(node => node.scrollTop)
        await page.evaluate(() => window.__goalHarness.append('\n\nNewly received plan additions.'.repeat(30)))
        assert.equal(await transcript.evaluate(node => node.scrollTop), previousScroll)
        await expect(jump).toBeVisible()
        await jump.click()
        await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2)
        await expect(jump).toHaveCount(0)
        await input.focus()
        await page.evaluate(() => window.__goalHarness.append('\n\nRetain input focus and live output.'))
        await expect(input).toBeFocused()
        assert(await assistantMessages.last().evaluate(node => node.getAnimations({ subtree: true }).length === 0))
        await page.evaluate(() => window.__goalHarness.finish('completed'))
        await expect(pending).toHaveCount(0)
        await expect(assistantMessages).toHaveCount(5)
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight))
        assert(await page.locator('.goal-assistant-composer').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight))
        assert(await page.locator('.goal-assistant-draft').evaluate(node => node.getBoundingClientRect().right <= innerWidth))
        await page.screenshot({ path: `${prefix}-completed.png`, fullPage: true })
        report.scenarios.push({ width, height, theme, reducedMotion, connectingAndThinkingInTranscript: true, spinnerAnimation: spinnerStyle.name, incrementalBeforeCompletion: true, stableMessageAndMarkdownDOM: true, noTokenOrMessageAnimation: true, everyInternalFenceCharacterHidden: true, completeFailedStoppedClearLoading: true, repeatedTurnsRetainedWithoutDuplicates: 5, codexAndClaudeProjection: true, scrollUpPreserved: true, jumpToLatest: true, inputFocusPreserved: true, keyboardStopDispatchedImmediately: true, stopButtonFocusPreservedDuringStreamBeforeActivation: true, noOverflow: true })
        await context.close()
      }
    }
  }
  assert.deepEqual(report.errors, [])
  report.status = 'passed'
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  throw error
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
