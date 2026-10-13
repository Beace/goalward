import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'

const output = process.env.NATIVE_WORKSPACE_SMOKE_RESULTS ?? 'test-results/native-workspaces'
const delivery = process.env.NATIVE_WORKSPACE_SMOKE_OUTPUT ?? '/Users/bytedance/.codex/visualizations/2026/10/13/01a13326-b799-7a91-80e8-8b02f310e7d7/native-workspaces'
const base = process.env.NATIVE_WORKSPACE_SMOKE_URL ?? 'http://127.0.0.1:1421'
const composerValidation = process.env.GOAL_COMPOSER_SMOKE === '1'
const longRuntimeName = 'Codex · Native sessions and goal assistant composer with a long runtime name'
const version = Date.now()
await mkdir(output, { recursive: true }); await mkdir(delivery, { recursive: true })
await writeFile(`${output}/harness.html`, '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="./synthetic-ipc.js"></script><script type="module" src="./harness.tsx"></script></body></html>')
await writeFile(`${output}/harness.tsx`, `
import { createRoot } from 'react-dom/client'
import { createInitialState } from '/src/lib/domain'
import { createGoal } from '/src/lib/goals'
import { createWorkspaceTask } from '/src/lib/workspace'
import '/src/index.css'
const state=createInitialState()
state.settings.language='zh'; state.settings.theme=window.__fixtureTheme
state.settings.runtimes=state.settings.runtimes.map(runtime=>({...runtime,enabled:runtime.adapter==='codex'}))
if (${composerValidation}) state.settings.runtimes.find(runtime=>runtime.id==='codex').name=${JSON.stringify(longRuntimeName)}
state.onboarding={version:1,completedAt:new Date().toISOString(),outcome:'configured'}
const goal={...createGoal({title:'Fixed directory and native session browser verification',expected:'Continue interacting according to actual protocol capabilities',currentSummary:'File metadata and Runtime events are synthetic; no local Agent was started.'}),workingDirectories:['/synthetic/workspaces/a-long-café-project-directory/a-project-folder with spaces/with-a-long-project-name','/synthetic/data']}
const task=createWorkspaceTask(state.settings,{title:'Initial task',goalId:goal.id,workingDirectories:goal.workingDirectories})
state.goals=[goal];state.tasks=[task];state.activeGoalId=goal.id;state.activeTaskId=task.id
window.__nativeState=state
const {default:App}=await import('/src/App')
createRoot(document.getElementById('root')).render(<App/>);
const banner=document.createElement('div');banner.textContent='Synthetic UI verification · No Runtime started or local files read';banner.style.cssText='position:fixed;left:360px;right:120px;bottom:1px;height:22px;line-height:22px;color:var(--muted-foreground);font-size:10px;text-align:center;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:100';document.body.append(banner)
`)

const installSyntheticIpc=theme=>{
    window.isTauri=true;window.__fixtureTheme=theme;window.__nativeState=null;window.__calls=[];window.__requests=[];window.__steers=[];window.__stops=[];window.__approvals=[];window.__approvalFail=true;window.__searches=[];window.__eventSequence=0
    const callbacks=new Map();const listeners=new Map();let callbackId=0,listenerId=0
    window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}}
    window.__emitRuntime=(frame,kind='stdout',request=window.__requests.at(-1))=>{
      const event={id:'synthetic-'+(++window.__eventSequence),taskId:request.taskId,runId:request.runId,memberId:request.memberId,timestamp:new Date().toISOString(),kind,text:kind==='stdout'?JSON.stringify(frame)+'\n':frame??'',exitCode:kind==='completed'?0:undefined}
      for(const [eventName,handler] of listeners.values()) if(eventName==='runtime-event') callbacks.get(handler)?.({event:eventName,id:listenerId,payload:event})
    }
    window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:fn=>{const id=++callbackId;callbacks.set(id,fn);return id},unregisterCallback:id=>callbacks.delete(id),invoke:async(command,args={})=>{
      window.__calls.push({command,args})
      if(command==='load_workspace_summary')return structuredClone(window.__nativeState)
      if(command==='save_state_delta'){
        const prior=new Map(window.__nativeState.tasks.map(task=>[task.id,task]))
        window.__nativeState={...structuredClone(args.state),tasks:args.state.tasks.map(task=>{const events=[...(prior.get(task.id)?.events??[]),...task.events];return {...structuredClone(task),events:[...new Map(events.map(event=>[event.id,event])).values()]}})};return
      }
      if(command==='load_trace_events')return []
      if(command==='active_runtime_turns')return []
      if(command==='load_task_event_page')return {events:window.__nativeState.tasks.find(task=>task.id===args.taskId)?.events??[],next:null,through:0}
      if(command==='check_app_update')return {currentVersion:'0.1.1'}
      if(command==='list_system_fonts')return ['Inter','PingFang SC']
      if(command==='ensure_goal_assistant_directory')return '/synthetic/app-managed/'+args.goalId
      if(command==='plugin:event|listen'){const id=++listenerId;listeners.set(id,[args.event,args.handler]);return id}
      if(command==='plugin:event|unlisten'){listeners.delete(args.eventId);return}
      if(command==='search_workspace_entries'){
        window.__searches.push(args)
        const root=args.directories[0];const entries=[{name:'résumé document.md',kind:'file'},{name:'café folder',kind:'folder'}].map(entry=>({...entry,path:root+'/'+entry.name,relativePath:entry.name,root}))
        return {entries:entries.filter(entry=>(entry.name+' '+entry.path).toLowerCase().includes(args.query.toLowerCase())),truncated:false}
      }
      if(command==='start_run'){
        window.__requests.push(args.request)
        setTimeout(()=>{window.__emitRuntime('synthetic native connection ready','started',args.request);window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:true,followUp:false,approvals:true}},'stdout',args.request)},0);return
      }
      if(command==='steer_run'){window.__steers.push(args);return}
      if(command==='stop_run'){window.__stops.push(args);const request=window.__requests.find(request=>request.runId===args.runId&&request.memberId===args.memberId)||window.__requests.at(-1);window.__emitRuntime('synthetic turn stopped','stopped',request);return}
      if(command==='respond_runtime_permission'){window.__approvals.push(args);if(window.__approvalFail){window.__approvalFail=false;throw new Error('synthetic approval transport failure')}window.__emitRuntime({type:'runtime.permission_resolved',requestId:args.requestId},'stdout',window.__requests.find(request=>request.runId===args.runId));return}
      if(command==='read_clipboard_attachments')return []
      if(command==='plugin:notification|is_permission_granted')return false
      if(command==='plugin:notification|request_permission')return 'denied'
      if(command.startsWith('plugin:window|'))return
      throw new Error('Unexpected synthetic IPC: '+command)
    }}

}
await writeFile(`${output}/synthetic-ipc.js`, `(${installSyntheticIpc.toString()})(new URLSearchParams(location.search).get('theme') || window.__fixtureTheme || 'dark')`)

const report = { status: 'running', interactiveUrl: `${base}/${output}/harness.html?theme=dark`, scope: 'Actual App, GoalsPage, GoalWorkspaceDirectories, Workbench, GoalAssistant, WorkspaceMentionInput and RuntimeApprovalPanel with actual shared controls. Tauri IPC, metadata search, native capabilities, approvals and Runtime frames are explicitly synthetic. No local Agent process or model inference is started.', scenarios: [], errors: [] }
if (composerValidation) report.scope += ' Task and Goal composer computed styles, automatic textarea growth, the initial Goal page, long Runtime names, focus and keyboard behavior are compared using the real rendered DOM.'

async function composerGeometry(input) {
  // Border feedback is a shared CSS transition. Compare its settled focused
  // value, rather than accidentally comparing different transition frames.
  const ring = await input.evaluate(node => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = 'var(--color-ring)'
    node.parentElement.append(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
  await expect.poll(() => input.evaluate(node => getComputedStyle(node.closest('.composer')).borderTopColor)).toBe(ring)
  return input.evaluate(node => {
    const composer = node.closest('.composer')
    if (!composer) throw new Error('The real input is not inside the shared composer surface')
    const readStyle = (element, properties) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(properties.map(property => [property, style[property]]))
    }
    const bounds = element => {
      const box = element.getBoundingClientRect()
      return { width: box.width, height: box.height, top: box.top, bottom: box.bottom, left: box.left, right: box.right }
    }
    const send = composer.querySelector('.composer-send')
    const recipient = composer.querySelector('.composer-recipient')
    if (!send || !recipient) throw new Error('Shared recipient or send region is missing')
    const trigger = recipient.querySelector('.composer-recipient-trigger')
    if (!trigger) throw new Error('Shared recipient trigger is missing')
    return {
      surface: readStyle(composer, ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderTopStyle', 'borderRadius']),
      input: readStyle(node, ['backgroundColor', 'borderTopWidth', 'borderRadius', 'boxShadow', 'fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'minHeight', 'maxHeight', 'resize', 'fieldSizing', 'overflowY', 'transitionProperty']),
      send: readStyle(send, ['width', 'height', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']),
      trigger: readStyle(trigger, ['fontSize', 'lineHeight', 'fontWeight', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderRadius']),
      chevrons: [...trigger.querySelectorAll(':scope > svg')].map(svg => readStyle(svg, ['width', 'height', 'opacity'])),
      bounds: { surface: bounds(composer), input: bounds(node), send: bounds(send), recipient: bounds(recipient) },
      settings: composer.querySelector('.composer-settings') ? bounds(composer.querySelector('.composer-settings')) : undefined,
      inputScrollHeight: node.scrollHeight,
      overflowing: composer.scrollWidth > composer.clientWidth,
      recipientOverflowing: recipient.scrollWidth > recipient.clientWidth,
      focused: document.activeElement === node,
      animations: node.getAnimations().map(animation => animation.effect?.getKeyframes()),
    }
  })
}

async function measureComposerGrowth(input) {
  const cases = [
    { name: 'singleLine', text: 'Short single-line message' },
    { name: 'threeLines', text: 'First line\nSecond line\nThird line' },
    { name: 'capped', text: Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n') },
    { name: 'shrunk', text: 'Delete back to one line' },
  ]
  const measured = {}
  for (const item of cases) {
    await input.fill(item.text)
    await expect(input).toBeFocused()
    await expect.poll(() => input.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40)
    measured[item.name] = await input.evaluate(node => ({ height: node.getBoundingClientRect().height, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }))
  }
  assert(measured.threeLines.height > measured.singleLine.height, 'Explicit newlines must grow the composer immediately')
  assert.equal(measured.capped.height, 160, 'Long input must cap at 160 px')
  assert(measured.capped.scrollHeight > measured.capped.clientHeight, 'Long input must scroll within the capped textarea')
  assert.equal(measured.shrunk.height, measured.singleLine.height, 'Deleting content must shrink the composer back')
  await input.fill('')
  return measured
}

function assertMatchingComposer(task, goal, label) {
  assert.deepEqual(goal.surface, task.surface, `${label}: composer background, border and radius must match the Task composer`)
  assert.deepEqual(goal.input, task.input, `${label}: textarea computed styles must match the Task composer`)
  assert.deepEqual(goal.send, task.send, `${label}: send button computed styles must match the Task composer`)
  assert.deepEqual(goal.trigger, task.trigger, `${label}: recipient trigger typography, height and spacing must match the Task composer`)
  assert.deepEqual(goal.chevrons, task.chevrons, `${label}: recipient chevrons must match the Task composer`)
  assert.equal(goal.bounds.send.width, 32)
  assert.equal(goal.bounds.send.height, 32)
  assert.equal(goal.overflowing, false, `${label}: composer must not overflow horizontally`)
  assert.equal(goal.recipientOverflowing, false, `${label}: long Runtime names must fit the recipient row`)
  if (goal.settings) {
    assert(goal.settings.width >= 28 && goal.settings.height >= 28, `${label}: the settings button must keep its pointer target`)
    assert(goal.settings.left >= goal.bounds.surface.left && goal.settings.right <= goal.bounds.surface.right, `${label}: long Runtime names must preserve the settings button boundary`)
  }
  assert(goal.bounds.send.right <= goal.bounds.surface.right && goal.bounds.send.bottom <= goal.bounds.surface.bottom, `${label}: the send button must remain inside the composer`)
}

async function assertReferenceMenuVisible(menu, input) {
  const menuBox = await menu.boundingBox()
  const inputBox = await input.boundingBox()
  assert(menuBox.y + menuBox.height <= inputBox.y, 'Reference suggestions must appear above the textarea')
  assert(await menu.getByRole('option').first().evaluate(node => {
    const box = node.getBoundingClientRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return Boolean(hit && node.contains(hit))
  }), 'Reference menu options above the composer must remain visible and clickable')
}

async function expectReferenceCaretRestored(input) {
  // Choosing a reference restores focus/caret on the next animation frame.
  // Complete that interaction before the browser fixture selects replacement
  // text; otherwise the pending caret restoration can overwrite fill's select.
  await input.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
  await expect(input).toBeFocused()
  await expect.poll(() => input.evaluate(node => node.selectionStart === node.value.length && node.selectionEnd === node.value.length)).toBe(true)
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
for (const [width,height] of [[1536,960],[1280,720]]) for (const theme of ['light','dark']) for (const reducedMotion of ['no-preference','reduce']) {
  const context=await browser.newContext({viewport:{width,height},locale:'zh-CN',colorScheme:theme,reducedMotion})
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message))
  await page.addInitScript(installSyntheticIpc,theme)
  await page.goto(`${base}/${output}/harness.html?theme=${theme}&v=${version}`)
  const prefix=`${width}-${theme}-${reducedMotion}`
  const directoryTrigger=page.getByRole('button',{name:'管理目标工作目录',exact:true})
  await expect(directoryTrigger).toBeVisible();await directoryTrigger.click()
  assert(await page.locator('.goal-workspaces').evaluate(node=>node.scrollWidth<=node.clientWidth))
  assert(await page.locator('.goal-workspace-row').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth&&node.getBoundingClientRect().height>=40)))
  await expect(directoryTrigger).toHaveAttribute('aria-expanded','true')
  const directoryContent=page.locator('.goal-workspaces > [data-slot=collapsible-content]')
  await expect(directoryContent).toHaveAttribute('data-collapsible-motion','idle')
  const reversal=await directoryTrigger.evaluate(async node=>{const surface=node.closest('.goal-workspaces').querySelector('[data-slot=collapsible-content]');const phases=[];for(let i=0;i<3;i++){node.click();await new Promise(resolve=>requestAnimationFrame(resolve));phases.push({open:node.getAttribute('aria-expanded'),phase:surface.dataset.collapsibleMotion})}return phases})
  assert.deepEqual(reversal.map(value=>value.open),['false','true','false'])
  if(reducedMotion==='reduce')assert(reversal.every(value=>value.phase==='idle'));else assert(reversal.some(value=>value.phase==='animating'))
  await directoryTrigger.click();await expect(directoryContent).toHaveAttribute('data-collapsible-motion','idle')
  const directoryInput=page.getByRole('textbox',{name:'添加目标工作目录路径',exact:true})
  await directoryInput.focus();await directoryTrigger.evaluate(node=>node.click());await expect(directoryTrigger).toBeFocused();await directoryTrigger.click()
  const primary='/synthetic/extra/résumé data'
  await directoryInput.fill(primary);await directoryInput.press('Enter');await expect(directoryInput).toHaveValue('')
  await page.getByRole('button',{name:`设为主目录: ${primary}`,exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.__nativeState.goals[0].workingDirectories[0])).toBe(primary)
  const roots=await page.evaluate(()=>window.__nativeState.goals[0].workingDirectories)
  for(const directory of roots.slice(1))await page.getByRole('button',{name:`移除目录引用: ${directory}`,exact:true}).click()
  await expect(page.getByRole('button',{name:`移除目录引用: ${primary}`,exact:true})).toBeDisabled()
  const directoryRows=await page.locator('.goal-workspace-row').evaluateAll(nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,overflow:node.scrollWidth>node.clientWidth})))
  assert(directoryRows.every(row=>row.height>=40&&!row.overflow))
  await page.screenshot({path:`${output}/${prefix}-directories.png`})
  await copyFile(`${output}/${prefix}-directories.png`,`${delivery}/${prefix}-directories.png`)

  await page.locator('.goal-header-actions').getByRole('button',{name:'创建任务',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'新建任务',exact:true})
  await expect(dialog).toBeVisible();assert.equal(await dialog.getByRole('textbox',{name:/目录|directory/i}).count(),0)
  await dialog.getByLabel('任务目标',{exact:true}).fill('Task inheriting goal working directories')
  await dialog.getByRole('button',{name:'创建任务',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.locator('[data-dialog-exit]')).toHaveCount(0)
  await expect(page.getByRole('textbox',{name:'任务指令',exact:true})).toBeVisible()
  const taskSnapshot=await page.evaluate(()=>window.__nativeState.tasks.find(task=>task.title==='Task inheriting goal working directories'))
  assert.deepEqual(taskSnapshot.workingDirectories,[primary]);assert.equal(taskSnapshot.directory,primary)
  const input=page.getByRole('textbox',{name:'任务指令',exact:true})
  const menu=page.getByLabel('引用文件或文件夹',{exact:true})
  let taskComposer, taskGrowth, goalComposer, goalGrowth, startComposer, startGrowth
  if (composerValidation) {
    taskGrowth = await measureComposerGrowth(input)
    await input.fill('Task composer style baseline')
    taskComposer = await composerGeometry(input)
    assert.equal(taskComposer.focused, true)
    await page.screenshot({path:`${output}/${prefix}-task-composer.png`});await copyFile(`${output}/${prefix}-task-composer.png`,`${delivery}/${prefix}-task-composer.png`)
    await input.fill('')
  }
  await input.fill('@');await expect(menu.getByRole('option')).toHaveCount(2)
  if (composerValidation) await assertReferenceMenuVisible(menu,input)
  await page.screenshot({path:`${output}/${prefix}-references.png`});await copyFile(`${output}/${prefix}-references.png`,`${delivery}/${prefix}-references.png`)
  await input.press('ArrowDown');await input.press('Enter')
  await expect(input).toHaveValue(`@${JSON.stringify(primary+'/café folder')} `);await expectReferenceCaretRestored(input);await expect(menu).toHaveCount(0)
  await input.fill('@résumé');await expect(menu.getByRole('option')).toHaveCount(1);await menu.getByRole('option').click()
  await expect(input).toHaveValue(`@${JSON.stringify(primary+'/résumé document.md')} `);await expectReferenceCaretRestored(input)
  await input.fill('@');await expect(menu).toBeVisible();await input.press('Escape');await expect(menu).toHaveCount(0);await expect(input).toHaveValue('@')
  await input.fill('@résumé');await expect(menu).toBeVisible()
  await input.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})))
  assert.equal(await page.evaluate(()=>window.__requests.length),0);await expect(input).toHaveValue('@résumé');await expect(menu).toBeVisible()
  await menu.getByRole('option').click();await expectReferenceCaretRestored(input);await input.press('Control+Enter')
  await expect.poll(()=>page.evaluate(()=>window.__requests.length)).toBe(1)
  await expect(page.getByRole('button',{name:'追加消息',exact:true})).toBeVisible()
  await input.fill('Add a sentence while running');await input.press('Control+Enter');await expect.poll(()=>page.evaluate(()=>window.__steers.length)).toBe(1)
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:false,followUp:true,approvals:true}}))
  await input.fill('Queue the next message');await page.getByRole('button',{name:'排队追加消息',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__steers.length)).toBe(2)
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:false,followUp:false,approvals:true}}))
  await input.fill('Keep input when unsupported');await expect(page.getByRole('button',{name:'发送指令',exact:true})).toBeDisabled()
  await input.press('Control+Enter');assert.equal(await page.evaluate(()=>window.__steers.length),2);await expect(input).toHaveValue('Keep input when unsupported')
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:true,followUp:false,approvals:true}}))
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.permission_requested',requestId:'synthetic-approval',toolCall:{title:'Synthetic tool request: read a project file',rawInput:{path:'/synthetic/file.md'}},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Reject',kind:'reject_once'}]}))
  const approvals=page.getByLabel('Runtime 待审批请求',{exact:true});await expect(approvals).toBeVisible()
  await approvals.getByRole('button',{name:'Allow once',exact:true}).click();await expect(approvals.getByRole('alert').last()).toContainText('synthetic approval transport failure')
  await approvals.getByRole('button',{name:'Allow once',exact:true}).click();await expect(approvals).toHaveCount(0)
  assert.equal(await page.evaluate(()=>window.__approvals.length),2)
  await page.evaluate(()=>{window.__emitRuntime({method:'turn/started',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn'}}});window.__emitRuntime({type:'codex.app_server.item',eventType:'item.started',threadId:'synthetic-thread',turnId:'synthetic-turn',item:{id:'synthetic-tool',type:'commandExecution',command:'synthetic inspect files',status:'inProgress'}});window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'First streaming output segment.'}})})
  const article=page.locator('.message-assistant').last();await expect(article.locator('.markdown-body')).toContainText('First streaming output segment.')
  await article.evaluate(node=>{window.__streamArticle=node;window.__streamBody=node.querySelector('.markdown-body')})
  await input.focus()
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'The second segment is visible while execution remains active.'}}))
  assert(await article.evaluate(node=>node===window.__streamArticle&&node.querySelector('.markdown-body')===window.__streamBody));await expect(input).toBeFocused()
  await page.evaluate(()=>{window.__emitRuntime({type:'codex.app_server.item',eventType:'item.started',threadId:'synthetic-thread',turnId:'synthetic-turn',item:{id:'synthetic-mcp',type:'mcpToolCall',server:'synthetic-source',tool:'lookup_metadata',status:'inProgress',arguments:{query:'synthetic files'}}});window.__emitRuntime({method:'item/mcpToolCall/progress',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-mcp',message:'Synthetic file metadata read in progress'}})})
  const spinnerAnimation=await article.locator('.message-foot .animate-spin').evaluate(node=>getComputedStyle(node).animationName)
  assert.equal(spinnerAnimation,reducedMotion==='reduce'?'none':'spin')
  await page.getByRole('button',{name:'打开执行检查器',exact:true}).click()
  await expect(page.locator('.trace-panel')).toContainText('synthetic inspect files');await expect(page.locator('.trace-panel')).toContainText('Synthetic file metadata read in progress')
  await page.getByRole('button',{name:'收起检查器',exact:true}).click()
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'\n\n'+Array.from({length:70},(_,index)=>'Synthetic streaming entry '+index+': preserve the current scroll position.').join('\n\n')}}))
  const transcript=page.getByLabel('任务对话记录',{exact:true});await expect.poll(()=>transcript.evaluate(node=>node.scrollHeight-node.clientHeight)).toBeGreaterThan(500)
  await transcript.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}))});const scroll=await transcript.evaluate(node=>node.scrollTop)
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'\n\nAdditional content'.repeat(15)}}))
  assert.equal(await transcript.evaluate(node=>node.scrollTop),scroll);assert(await article.evaluate(node=>node===window.__streamArticle));assert(await article.evaluate(node=>node.getAnimations().length===0&&node.querySelector('.markdown-body').getAnimations({subtree:true}).length===0))
  await page.screenshot({path:`${output}/${prefix}-streaming.png`});await copyFile(`${output}/${prefix}-streaming.png`,`${delivery}/${prefix}-streaming.png`)
  await page.getByRole('button',{name:'停止执行',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__stops.length)).toBe(1)
  await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0)
  await expect(article).toContainText('First streaming output segment.The second segment is visible')
  assert.equal(await page.evaluate(()=>window.__nativeState.tasks.find(task=>task.title==='Task inheriting goal working directories').runs[0].directory),primary)
  const navigation=page.getByRole('navigation',{name:'工作空间导航',exact:true});await navigation.getByRole('button',{name:/^目标\s*\d/}).click()
  await page.getByRole('tab',{name:'目标助手',exact:true}).click()
  const goalInput=page.getByRole('textbox',{name:'给目标助手的消息',exact:true})
  if (composerValidation) {
    goalGrowth = await measureComposerGrowth(goalInput)
    assert.deepEqual(goalGrowth, taskGrowth, 'Task and Goal inputs must grow and shrink to the same heights')
    await goalInput.fill('Goal assistant composer style comparison')
    goalComposer = await composerGeometry(goalInput)
    assertMatchingComposer(taskComposer, goalComposer, 'Existing Goal')
    await page.screenshot({path:`${output}/${prefix}-goal-composer.png`});await copyFile(`${output}/${prefix}-goal-composer.png`,`${delivery}/${prefix}-goal-composer.png`)
    await goalInput.fill('@')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('option')).toHaveCount(2)
    await assertReferenceMenuVisible(menu,goalInput)
    await goalInput.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})))
    assert.equal(await page.evaluate(()=>window.__requests.length),1)
    await expect(goalInput).toHaveValue('@');await expect(menu).toBeVisible()
    await goalInput.press('Escape');await expect(menu).toHaveCount(0);await expect(goalInput).toBeFocused()
  }
  await goalInput.fill('@café');await expect(menu.getByRole('option')).toHaveCount(1);await menu.getByRole('option').click();await expect(goalInput).toHaveValue(`@${JSON.stringify(primary+'/café folder')} `);await expectReferenceCaretRestored(goalInput)
  await goalInput.press('Control+Enter');await expect.poll(()=>page.evaluate(()=>window.__requests.length)).toBe(2)
  await expect(page.getByRole('button',{name:'追加消息',exact:true})).toBeVisible()
  const assistantRequest=await page.evaluate(()=>window.__requests.at(-1));assert.equal(assistantRequest.directory,primary);assert.equal(assistantRequest.runtime.permissions.codex.sandbox,'read-only')
  const goalDetails=page.locator('.goal-assistant-transcript .goal-assistant-run-details')
  await expect(goalDetails).toHaveCount(1);await expect(page.locator('.goal-assistant-transcript .goal-assistant-pending-status')).toHaveCount(0)
  assert(await page.evaluate(()=>{const request=window.__requests.at(-1);const task=window.__nativeState.tasks.find(task=>task.id===request.taskId);return task.runs.at(-1).context.goal.id===window.__nativeState.goals[0].id}))
  await page.evaluate(()=>{
    window.__emitRuntime({type:'codex.app_server.thread_ready',threadId:'goal-thread',model:'synthetic-confirmed-goal-model',modelProvider:'synthetic-provider',reasoningEffort:'medium'})
    window.__emitRuntime({method:'turn/started',params:{threadId:'goal-thread',turn:{id:'goal-turn'}}})
    window.__emitRuntime({type:'codex.app_server.item',eventType:'item.started',threadId:'goal-thread',turnId:'goal-turn',item:{id:'goal-mcp',type:'mcpToolCall',server:'synthetic-goal-source',tool:'lookup_goal_context',status:'inProgress',arguments:{query:'goal clarification'}}})
    window.__emitRuntime({method:'item/mcpToolCall/progress',params:{threadId:'goal-thread',turnId:'goal-turn',itemId:'goal-mcp',message:'Synthetic clarification in progress: reading goal material'}})
  })
  await expect(goalDetails.locator('.goal-run-state')).toHaveText('正在执行工具')
  await expect(goalDetails.locator('.goal-run-activity')).toContainText('Synthetic clarification in progress: reading goal material')
  await expect(goalDetails.locator('.goal-run-identity')).toContainText('synthetic-confirmed-goal-model')
  const goalSpinner=await goalDetails.locator('.goal-run-summary [data-slot=spinner]').evaluate(node=>getComputedStyle(node).animationName)
  assert.equal(goalSpinner,reducedMotion==='reduce'?'none':'spin')
  await page.screenshot({path:`${output}/${prefix}-assistant-progress.png`});await copyFile(`${output}/${prefix}-assistant-progress.png`,`${delivery}/${prefix}-assistant-progress.png`)
  const goalTrigger=goalDetails.getByRole('button',{name:'调用详情',exact:true})
  const goalSurface=goalDetails.locator(':scope > [data-slot=collapsible-content]')
  await goalTrigger.focus();await goalTrigger.press('Enter');await expect(goalTrigger).toHaveAttribute('aria-expanded','true')
  await expect(goalSurface).toHaveAttribute('data-collapsible-motion','idle')
  await expect(goalDetails.locator('.goal-run-invocation .goal-run-metadata')).toContainText('Runtime 确认模型synthetic-confirmed-goal-model')
  await expect(goalDetails.locator('.goal-run-invocation .goal-run-metadata')).toContainText('Runtime 确认供应商synthetic-provider')
  await expect(goalDetails.locator('.goal-run-invocation .goal-run-metadata')).toContainText('会话 IDgoal-thread')
  await expect(goalDetails.locator('.goal-run-invocation .goal-run-metadata')).toContainText('轮次 IDgoal-turn')
  await expect(goalDetails.locator('.goal-run-trace')).toContainText('Synthetic clarification in progress: reading goal material')
  const goalReversal=await goalTrigger.evaluate(async node=>{const surface=node.closest('.goal-assistant-run-details').querySelector(':scope > [data-slot=collapsible-content]');const phases=[];for(let i=0;i<3;i++){node.click();await new Promise(resolve=>requestAnimationFrame(resolve));phases.push({open:node.getAttribute('aria-expanded'),phase:surface.dataset.collapsibleMotion})}return phases})
  assert.deepEqual(goalReversal.map(value=>value.open),['false','true','false'])
  if(reducedMotion==='reduce')assert(goalReversal.every(value=>value.phase==='idle'));else assert(goalReversal.some(value=>value.phase==='animating'))
  await goalTrigger.click();await expect(goalSurface).toHaveAttribute('data-collapsible-motion','idle')
  const composerBounds=await page.locator('.goal-assistant-composer').boundingBox();const stopBounds=await page.getByRole('button',{name:'停止目标助手',exact:true}).boundingBox()
  assert(composerBounds.y+composerBounds.height<=height&&stopBounds.y>=0&&stopBounds.y+stopBounds.height<=height)
  await expect(page.getByRole('button',{name:'停止生成建议',exact:true})).toHaveCount(0)
  await goalInput.fill('Continue clarifying');await page.getByRole('button',{name:'追加消息',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__steers.length)).toBe(3)
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'goal-thread',turnId:'goal-turn',itemId:'goal-answer',delta:'The goal assistant is streaming output.'}}))
  const goalArticle=page.locator('.goal-assistant-message-assistant').last();await expect(goalArticle).toContainText('The goal assistant is streaming output.')
  const goalResponse=goalDetails.getByLabel('本轮模型回复',{exact:true});await expect(goalResponse).toContainText('The goal assistant is streaming output.')
  await goalDetails.evaluate(node=>{window.__goalDetails=node});await goalArticle.evaluate(node=>{window.__goalArticle=node;window.__goalArticleBody=node.querySelector('.markdown-body')});await goalResponse.evaluate(node=>{window.__goalResponseBody=node.querySelector('.markdown-body')})
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'goal-thread',turnId:'goal-turn',itemId:'goal-answer',delta:'\n\n'+Array.from({length:55},(_,index)=>'Synthetic clarification material '+index+': record public calls and replies.').join('\n\n')}}))
  const goalTranscript=page.locator('.goal-assistant-transcript')
  await expect.poll(()=>goalTranscript.evaluate(node=>node.scrollHeight-node.clientHeight)).toBeGreaterThan(300)
  await expect.poll(()=>goalResponse.evaluate(node=>node.scrollHeight-node.clientHeight)).toBeGreaterThan(300)
  await goalTranscript.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}))})
  await goalResponse.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}))})
  const outerScroll=await goalTranscript.evaluate(node=>node.scrollTop);const innerScroll=await goalResponse.evaluate(node=>node.scrollTop)
  await goalInput.focus()
  await page.evaluate(()=>{window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'goal-thread',turnId:'goal-turn',itemId:'goal-answer',delta:'\n\nAppend a streaming reply and retain the current reading position.'}});window.__emitRuntime({method:'item/mcpToolCall/progress',params:{threadId:'goal-thread',turnId:'goal-turn',itemId:'goal-mcp',message:'Synthetic clarification in progress: continue checking public sources'}})})
  assert.equal(await goalTranscript.evaluate(node=>node.scrollTop),outerScroll);assert.equal(await goalResponse.evaluate(node=>node.scrollTop),innerScroll)
  assert(await goalDetails.evaluate(node=>node===window.__goalDetails));assert(await goalArticle.evaluate(node=>node===window.__goalArticle&&node.querySelector('.markdown-body')===window.__goalArticleBody));assert(await goalResponse.evaluate(node=>node.querySelector('.markdown-body')===window.__goalResponseBody));await expect(goalInput).toBeFocused()
  assert(await goalArticle.evaluate(node=>node.getAnimations().length===0&&node.querySelector('.markdown-body').getAnimations({subtree:true}).length===0))
  await goalDetails.locator('.goal-run-invocation').scrollIntoViewIfNeeded()
  await page.screenshot({path:`${output}/${prefix}-assistant-details.png`});await copyFile(`${output}/${prefix}-assistant-details.png`,`${delivery}/${prefix}-assistant-details.png`)
  await goalTrigger.click();await expect(goalSurface).toHaveAttribute('data-collapsible-motion','idle')
  await page.screenshot({path:`${output}/${prefix}-assistant.png`});await copyFile(`${output}/${prefix}-assistant.png`,`${delivery}/${prefix}-assistant.png`)
  await page.getByRole('button',{name:'停止目标助手',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__stops.length)).toBe(2)
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight))
  assert(await page.locator('.goal-assistant-composer').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight))
  if (composerValidation) {
    await navigation.getByRole('button',{name:'开始一件事',exact:true}).click()
    await expect(page.locator('.goal-assistant-start')).toBeVisible()
    const startInput = page.getByRole('textbox',{name:'给目标助手的消息',exact:true})
    startGrowth = await measureComposerGrowth(startInput)
    assert.deepEqual(startGrowth, taskGrowth, 'The initial Goal input must share the same automatic height limits')
    await startInput.fill('The start page retains the same composer style')
    startComposer = await composerGeometry(startInput)
    assertMatchingComposer(taskComposer, startComposer, 'Initial Goal page')
    assert(startComposer.bounds.surface.bottom <= height)
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight))
    await page.screenshot({path:`${output}/${prefix}-start-composer.png`});await copyFile(`${output}/${prefix}-start-composer.png`,`${delivery}/${prefix}-start-composer.png`)
    const runtimeTrigger = page.getByRole('combobox',{name:'目标助手 Runtime',exact:true})
    await runtimeTrigger.focus();await runtimeTrigger.press('Enter')
    await expect(page.getByRole('option',{name:longRuntimeName,exact:true})).toBeVisible()
    await page.keyboard.press('Escape');await expect(runtimeTrigger).toBeFocused()
    await startInput.fill('Start page text input in progress')
    await startInput.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})))
    assert.equal(await page.evaluate(()=>window.__requests.length),2)
    await expect(startInput).toHaveValue('Start page text input in progress');await expect(startInput).toBeFocused()
  }
  report.scenarios.push({width,height,theme,reducedMotion,directoryRows,newTaskNoDirectoryInput:true,goalRootsInherited:true,dialogExitFullyRemoved:true,keyboardFileFolderWithSpacesAndChinese:true,mouseReference:true,escapeDismissal:true,imeDoesNotSend:true,controlEnterSend:true,steerQueueUnsupported:true,approvalFailureRetry:true,turnStop:true,goalAssistantReadOnly:true,clarificationToolProgress:true,clarificationModelThreadTurnDetails:true,clarificationNestedScrollPreserved:true,clarificationStableDOM:true,clarificationDisclosureReversal:goalReversal,goalComposerStopBounds:composerBounds,goalSpinner,toolProgressInTrace:true,spinnerAnimation,actualStreamingStableDOM:true,userScrollPreserved:true,sharedDisclosureReversal:reversal,noOverflow:true,...(composerValidation ? {taskComposer,goalComposer,startComposer,taskGrowth,goalGrowth,startGrowth,longRuntimeNames:true,initialGoalPage:true,matchingComputedStyles:true} : {})})
  console.log('Passed '+prefix);await context.close()
}
assert.deepEqual(report.errors,[]);report.status='passed'
} catch(error){report.status='failed';report.failure=error.stack??String(error);console.error(report.failure);process.exitCode=1}
finally{await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await writeFile(`${delivery}/report.json`,JSON.stringify(report,null,2));await writeFile(`${delivery}/validation.md`,'# Native workspace browser validation\n\n'+report.scope+'\n\nStatus: '+report.status+'\n\n'+report.scenarios.map(scenario=>'- '+scenario.width+' x '+scenario.height+' / '+scenario.theme+' / '+scenario.reducedMotion+': passed').join('\n')+'\n\n'+(report.failure??''));await browser.close()}
