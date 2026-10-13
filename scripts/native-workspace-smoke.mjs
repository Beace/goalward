import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, copyFile } from 'node:fs/promises'

const output = 'test-results/native-workspaces'
const delivery = process.env.NATIVE_WORKSPACE_SMOKE_OUTPUT ?? '/Users/bytedance/.codex/visualizations/2026/10/13/01a13326-b799-7a91-80e8-8b02f310e7d7/native-workspaces'
const base = process.env.NATIVE_WORKSPACE_SMOKE_URL ?? 'http://127.0.0.1:1421'
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
state.onboarding={version:1,completedAt:new Date().toISOString(),outcome:'configured'}
const goal={...createGoal({title:'固定目录与原生会话浏览器验证',expected:'按实际协议能力持续交互',currentSummary:'这里的文件元数据与 Runtime 事件均为 synthetic，未启动本机 Agent。'}),workingDirectories:['/synthetic/workspaces/很长的中文项目目录/包含空格的项目文件夹/with-a-long-project-name','/synthetic/data']}
const task=createWorkspaceTask(state.settings,{title:'初始任务',goalId:goal.id,workingDirectories:goal.workingDirectories})
state.goals=[goal];state.tasks=[task];state.activeGoalId=goal.id;state.activeTaskId=task.id
window.__nativeState=state
const {default:App}=await import('/src/App')
createRoot(document.getElementById('root')).render(<App/>);
const banner=document.createElement('div');banner.textContent='Synthetic UI 验证 · 未启动 Runtime / 未读取本机文件';banner.style.cssText='position:fixed;left:360px;right:120px;bottom:1px;height:22px;line-height:22px;color:var(--muted-foreground);font-size:10px;text-align:center;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:100';document.body.append(banner)
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
        const root=args.directories[0];const entries=[{name:'说明 文档.md',kind:'file'},{name:'资料 文件夹',kind:'folder'}].map(entry=>({...entry,path:root+'/'+entry.name,relativePath:entry.name,root}))
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
  const primary='/synthetic/extra/含空格 数据'
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
  await dialog.getByLabel('任务目标',{exact:true}).fill('继承目标工作目录的任务')
  await dialog.getByRole('button',{name:'创建任务',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.locator('[data-dialog-exit]')).toHaveCount(0)
  await expect(page.getByRole('textbox',{name:'任务指令',exact:true})).toBeVisible()
  const taskSnapshot=await page.evaluate(()=>window.__nativeState.tasks.find(task=>task.title==='继承目标工作目录的任务'))
  assert.deepEqual(taskSnapshot.workingDirectories,[primary]);assert.equal(taskSnapshot.directory,primary)
  const input=page.getByRole('textbox',{name:'任务指令',exact:true})
  const menu=page.getByLabel('引用文件或文件夹',{exact:true})
  await input.fill('@');await expect(menu.getByRole('option')).toHaveCount(2)
  await page.screenshot({path:`${output}/${prefix}-references.png`});await copyFile(`${output}/${prefix}-references.png`,`${delivery}/${prefix}-references.png`)
  await input.press('ArrowDown');await input.press('Enter')
  await expect(input).toHaveValue(`@${JSON.stringify(primary+'/资料 文件夹')} `);await expect(input).toBeFocused();await expect.poll(()=>input.evaluate(node=>node.selectionStart===node.value.length)).toBe(true);await expect(menu).toHaveCount(0)
  await input.fill('@说明');await expect(menu.getByRole('option')).toHaveCount(1);await menu.getByRole('option').click()
  await expect(input).toHaveValue(`@${JSON.stringify(primary+'/说明 文档.md')} `);await expect(input).toBeFocused();await expect.poll(()=>input.evaluate(node=>node.selectionStart===node.value.length)).toBe(true)
  await input.fill('@');await expect(menu).toBeVisible();await input.press('Escape');await expect(menu).toHaveCount(0);await expect(input).toHaveValue('@')
  await input.fill('@说明');await expect(menu).toBeVisible()
  await input.evaluate(node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true})))
  assert.equal(await page.evaluate(()=>window.__requests.length),0);await expect(input).toHaveValue('@说明');await expect(menu).toBeVisible()
  await menu.getByRole('option').click();await input.press('Control+Enter')
  await expect.poll(()=>page.evaluate(()=>window.__requests.length)).toBe(1)
  await expect(page.getByRole('button',{name:'追加消息',exact:true})).toBeVisible()
  await input.fill('运行中追加一句');await input.press('Control+Enter');await expect.poll(()=>page.evaluate(()=>window.__steers.length)).toBe(1)
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:false,followUp:true,approvals:true}}))
  await input.fill('排队下一轮消息');await page.getByRole('button',{name:'排队追加消息',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__steers.length)).toBe(2)
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:false,followUp:false,approvals:true}}))
  await input.fill('不支持时保留输入');await expect(page.getByRole('button',{name:'发送指令',exact:true})).toBeDisabled()
  await input.press('Control+Enter');assert.equal(await page.evaluate(()=>window.__steers.length),2);await expect(input).toHaveValue('不支持时保留输入')
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.capabilities',capabilities:{steer:true,followUp:false,approvals:true}}))
  await page.evaluate(()=>window.__emitRuntime({type:'runtime.permission_requested',requestId:'synthetic-approval',toolCall:{title:'synthetic 工具请求：读取项目文件',rawInput:{path:'/synthetic/file.md'}},options:[{optionId:'allow',name:'允许一次',kind:'allow_once'},{optionId:'deny',name:'拒绝',kind:'reject_once'}]}))
  const approvals=page.getByLabel('Runtime 待审批请求',{exact:true});await expect(approvals).toBeVisible()
  await approvals.getByRole('button',{name:'允许一次',exact:true}).click();await expect(approvals.getByRole('alert').last()).toContainText('synthetic approval transport failure')
  await approvals.getByRole('button',{name:'允许一次',exact:true}).click();await expect(approvals).toHaveCount(0)
  assert.equal(await page.evaluate(()=>window.__approvals.length),2)
  await page.evaluate(()=>{window.__emitRuntime({method:'turn/started',params:{threadId:'synthetic-thread',turn:{id:'synthetic-turn'}}});window.__emitRuntime({type:'codex.app_server.item',eventType:'item.started',threadId:'synthetic-thread',turnId:'synthetic-turn',item:{id:'synthetic-tool',type:'commandExecution',command:'synthetic inspect files',status:'inProgress'}});window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'实时输出第一段。'}})})
  const article=page.locator('.message-assistant').last();await expect(article.locator('.markdown-body')).toContainText('实时输出第一段。')
  await article.evaluate(node=>{window.__streamArticle=node;window.__streamBody=node.querySelector('.markdown-body')})
  await input.focus()
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'第二段已经可见，当前执行仍未结束。'}}))
  assert(await article.evaluate(node=>node===window.__streamArticle&&node.querySelector('.markdown-body')===window.__streamBody));await expect(input).toBeFocused()
  await page.evaluate(()=>{window.__emitRuntime({type:'codex.app_server.item',eventType:'item.started',threadId:'synthetic-thread',turnId:'synthetic-turn',item:{id:'synthetic-mcp',type:'mcpToolCall',server:'synthetic-source',tool:'lookup_metadata',status:'inProgress',arguments:{query:'synthetic files'}}});window.__emitRuntime({method:'item/mcpToolCall/progress',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-mcp',message:'synthetic 正在读取文件元数据'}})})
  const spinnerAnimation=await article.locator('.message-foot .animate-spin').evaluate(node=>getComputedStyle(node).animationName)
  assert.equal(spinnerAnimation,reducedMotion==='reduce'?'none':'spin')
  await page.getByRole('button',{name:'打开执行检查器',exact:true}).click()
  await expect(page.locator('.trace-panel')).toContainText('synthetic inspect files');await expect(page.locator('.trace-panel')).toContainText('synthetic 正在读取文件元数据')
  await page.getByRole('button',{name:'收起检查器',exact:true}).click()
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'\n\n'+Array.from({length:70},(_,index)=>'synthetic 流式条目 '+index+'：保留当前滚动位置。').join('\n\n')}}))
  const transcript=page.getByLabel('任务对话记录',{exact:true});await expect.poll(()=>transcript.evaluate(node=>node.scrollHeight-node.clientHeight)).toBeGreaterThan(500)
  await transcript.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll',{bubbles:true}))});const scroll=await transcript.evaluate(node=>node.scrollTop)
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'synthetic-thread',turnId:'synthetic-turn',itemId:'synthetic-answer',delta:'\n\n后续追加内容'.repeat(15)}}))
  assert.equal(await transcript.evaluate(node=>node.scrollTop),scroll);assert(await article.evaluate(node=>node===window.__streamArticle));assert(await article.evaluate(node=>node.getAnimations().length===0&&node.querySelector('.markdown-body').getAnimations({subtree:true}).length===0))
  await page.screenshot({path:`${output}/${prefix}-streaming.png`});await copyFile(`${output}/${prefix}-streaming.png`,`${delivery}/${prefix}-streaming.png`)
  await page.getByRole('button',{name:'停止执行',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__stops.length)).toBe(1)
  await expect(page.getByRole('button',{name:'停止执行',exact:true})).toHaveCount(0)
  await expect(article).toContainText('实时输出第一段。第二段已经可见')
  assert.equal(await page.evaluate(()=>window.__nativeState.tasks.find(task=>task.title==='继承目标工作目录的任务').runs[0].directory),primary)
  const navigation=page.getByRole('navigation',{name:'工作空间导航',exact:true});await navigation.getByRole('button',{name:/^目标\s*\d/}).click()
  await page.getByRole('tab',{name:'目标助手',exact:true}).click()
  const goalInput=page.getByRole('textbox',{name:'给目标助手的消息',exact:true})
  await goalInput.fill('@资料');await expect(menu.getByRole('option')).toHaveCount(1);await menu.getByRole('option').click();await expect(goalInput).toHaveValue(`@${JSON.stringify(primary+'/资料 文件夹')} `)
  await goalInput.press('Control+Enter');await expect.poll(()=>page.evaluate(()=>window.__requests.length)).toBe(2)
  await expect(page.getByRole('button',{name:'追加消息',exact:true})).toBeVisible()
  const assistantRequest=await page.evaluate(()=>window.__requests.at(-1));assert.equal(assistantRequest.directory,primary);assert.equal(assistantRequest.runtime.permissions.codex.sandbox,'read-only')
  await goalInput.fill('继续澄清');await page.getByRole('button',{name:'追加消息',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__steers.length)).toBe(3)
  await page.evaluate(()=>window.__emitRuntime({method:'item/agentMessage/delta',params:{threadId:'goal-thread',turnId:'goal-turn',itemId:'goal-answer',delta:'目标助手正在实时输出。'}}))
  await expect(page.locator('.goal-assistant-message-assistant').last()).toContainText('目标助手正在实时输出。')
  await page.screenshot({path:`${output}/${prefix}-assistant.png`});await copyFile(`${output}/${prefix}-assistant.png`,`${delivery}/${prefix}-assistant.png`)
  await page.getByRole('button',{name:'停止目标助手',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__stops.length)).toBe(2)
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight))
  assert(await page.locator('.goal-assistant-composer').evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight))
  report.scenarios.push({width,height,theme,reducedMotion,directoryRows,newTaskNoDirectoryInput:true,goalRootsInherited:true,dialogExitFullyRemoved:true,keyboardFileFolderWithSpacesAndChinese:true,mouseReference:true,escapeDismissal:true,imeDoesNotSend:true,controlEnterSend:true,steerQueueUnsupported:true,approvalFailureRetry:true,turnStop:true,goalAssistantReadOnly:true,toolProgressInTrace:true,spinnerAnimation,actualStreamingStableDOM:true,userScrollPreserved:true,sharedDisclosureReversal:reversal,noOverflow:true})
  console.log('Passed '+prefix);await context.close()
}
assert.deepEqual(report.errors,[]);report.status='passed'
} catch(error){report.status='failed';report.failure=error.stack??String(error);console.error(report.failure);process.exitCode=1}
finally{await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));await writeFile(`${delivery}/report.json`,JSON.stringify(report,null,2));await writeFile(`${delivery}/validation.md`,'# Native workspace browser validation\n\n'+report.scope+'\n\nStatus: '+report.status+'\n\n'+report.scenarios.map(scenario=>'- '+scenario.width+' x '+scenario.height+' / '+scenario.theme+' / '+scenario.reducedMotion+': passed').join('\n')+'\n\n'+(report.failure??''));await browser.close()}
