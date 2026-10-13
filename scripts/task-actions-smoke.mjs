import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
const output = 'test-results/task-actions-implementation'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
const key = 'goalward.preview.v1'
const baseTitle = 'Organize desktop tool trial records'
const editedTitle = 'Organize desktop tool trial records and improvement suggestions'
try {
  for (const width of [1536, 1280]) for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width, height: width === 1536 ? 960 : 720 }, reducedMotion })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      window.taskDialogMotion=[]
      const original=Element.prototype.animate
      Element.prototype.animate=function(frames,options) {
        if(this.dataset?.slot?.startsWith('dialog'))window.taskDialogMotion.push({slot:this.dataset.slot,frames,options})
        return original.call(this,frames,options)
      }
    })
    const settleDialog = () => page.waitForFunction(() => !document.querySelector('[data-dialog-exit]') && [...document.querySelectorAll('[data-slot=dialog-content],[data-slot=dialog-overlay]')].every(element => Number(getComputedStyle(element).opacity) > 0.999))
    await page.goto('http://127.0.0.1:1420')
    await page.waitForFunction(storageKey => !!localStorage.getItem(storageKey), key)
    await page.evaluate(({key, title}) => {
      const state = JSON.parse(localStorage.getItem(key))
      const timestamp = new Date().toISOString()
      const task = {id:'sample-1',title,directory:'/tmp/task-actions-example',mode:'solo',members:[],createdAt:timestamp,messages:[{id:'message-1',role:'user',text:'Keep trial evidence',createdAt:timestamp}],events:[],runs:[{id:'run-1',createdAt:timestamp,directory:'/tmp/original',prompt:'Organize material',members:[],context:{task:{title,acceptance:'Keep original records',businessStatus:'todo'}}}],goalId:'goal-1',acceptance:'Keep original records',executor:'human',businessStatus:'todo',priority:'normal',dependencies:[],results:[],plan:[]}
      const source={kind:'task',label:'Task result: '+title,taskId:task.id,reference:'trial-records.md'}
      const snapshot={version:1,summary:'Completed the first trial',entries:[{id:'entry-1',kind:'artifact',text:'First trial records archived',source,createdAt:timestamp}],createdAt:timestamp,reason:'User verification',source}
      state.tasks=[task,{...task,id:'sample-2',title:'Plan the next trial',goalId:undefined,messages:[],runs:[],dependencies:['sample-1']}]
      state.goals=[{id:'goal-1',title:'Deliver a desktop tool ready for trial',intent:'',expected:'Complete core workflow acceptance',constraints:'',deadline:'',status:'active',version:1,criteria:[],definitions:[],currentState:snapshot,stateHistory:[],proposals:[],plan:[],reviews:[],createdAt:timestamp,updatedAt:timestamp}]
      state.agents=[];state.activeTaskId=task.id;state.activeGoalId='goal-1'
      localStorage.setItem(key,JSON.stringify(state))
    }, {key,title:baseTitle})
    await page.reload()
    const initial = await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key)
    const tasksNav=()=>page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^任务/})
    await tasksNav().click()
    expect(await page.locator('button button').count()).toBe(0)
    const edit = () => page.getByRole('button',{name:`编辑任务：${baseTitle}`,exact:true})
    await edit().click()
    await expect(page.getByRole('textbox',{name:'编辑任务名称'})).toBeFocused()
    await page.getByRole('textbox',{name:'编辑任务名称'}).fill('Unsaved name')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(edit()).toBeFocused()
    expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).tasks[0].title,key)).toBe(baseTitle)
    // Repeat before the prior opacity exit settles to exercise reversible shared motion.
    await edit().click()
    await page.getByRole('textbox',{name:'编辑任务名称'}).fill('   ')
    await expect(page.getByRole('button',{name:'保存任务',exact:true})).toBeDisabled()
    await page.getByRole('textbox',{name:'编辑任务名称'}).fill(editedTitle)
    await page.getByRole('textbox',{name:'编辑验收要求'}).fill('Original records and improvement suggestions have source evidence')
    await page.getByRole('textbox',{name:'编辑任务目录'}).fill('/tmp/next-task-workspace')
    await page.getByRole('combobox',{name:'任务优先级'}).click()
    await page.getByRole('option',{name:'高优先级',exact:true}).click()
    const saveBox = await page.getByRole('button',{name:'保存任务',exact:true}).boundingBox()
    expect(saveBox.y+saveBox.height).toBeLessThan((width===1536?960:720)-12)
    await settleDialog()
    await page.screenshot({path:`${output}/edit-${width}-${reducedMotion}.png`})
    await page.getByRole('button',{name:'保存任务',exact:true}).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button',{name:`编辑任务：${editedTitle}`,exact:true})).toBeFocused()
    let stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key)
    expect(stored.tasks[0].runs).toEqual(initial.tasks[0].runs)
    expect(stored.goals).toEqual(initial.goals)
    await page.reload();await tasksNav().click()
    await expect(page.getByRole('button',{name:`编辑任务：${editedTitle}`,exact:true})).toBeVisible()
    await page.screenshot({path:`${output}/list-${width}-${reducedMotion}.png`})
    await page.getByRole('button',{name:`删除任务：${editedTitle}`,exact:true}).click()
    await expect(page.getByRole('dialog').getByRole('button',{name:'取消',exact:true})).toBeFocused()
    await expect(page.getByRole('dialog').getByRole('button',{name:'删除任务',exact:true})).toBeDisabled()
    await expect(page.getByText('1 个任务仍依赖此任务', {exact:true})).toBeVisible()
    await settleDialog()
    await page.screenshot({path:`${output}/delete-blocked-${width}-${reducedMotion}.png`})
    await page.getByRole('dialog').getByRole('button',{name:'Plan the next trial'}).click()
    await expect(page.getByRole('heading',{name:'Plan the next trial',exact:true})).toBeFocused()
    await page.getByRole('button',{name:'编辑任务：Plan the next trial',exact:true}).click()
    await page.getByRole('checkbox',{name:editedTitle,exact:true}).uncheck()
    await page.getByRole('button',{name:'保存任务',exact:true}).click()
    await tasksNav().click()
    await page.getByRole('button',{name:`打开任务：${editedTitle}`,exact:true}).click()
    await expect(page.getByRole('heading',{name:editedTitle,exact:true})).toBeVisible()
    await page.getByRole('button',{name:`删除任务：${editedTitle}`,exact:true}).click()
    await expect(page.getByRole('dialog').getByText('1 条对话 · 1 次执行 · 0 项结果',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'取消',exact:true}).click()
    await expect(page.getByRole('button',{name:`删除任务：${editedTitle}`,exact:true})).toBeFocused()
    await page.getByRole('button',{name:`删除任务：${editedTitle}`,exact:true}).click()
    await settleDialog()
    await page.screenshot({path:`${output}/delete-${width}-${reducedMotion}.png`})
    await page.getByRole('dialog').getByRole('button',{name:'删除任务',exact:true}).click()
    await expect(page.getByRole('heading',{name:'任务',exact:true})).toBeFocused()
    await expect(page.getByRole('button',{name:`打开任务：${editedTitle}`,exact:true})).toHaveCount(0)
    stored=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key)
    expect(stored.tasks.map(task=>task.id)).toEqual(['sample-2'])
    expect(stored.goals).toEqual(initial.goals)
    await page.getByRole('navigation',{name:'工作空间导航'}).getByRole('button',{name:/^目标/}).click()
    await expect(page.getByText(/来源任务已删除/).first()).toBeVisible()
    await expect(page.getByRole('button',{name:'查看来源任务',exact:true})).toHaveCount(0)
    const motion=await page.evaluate(()=>window.taskDialogMotion)
    await page.reload();await tasksNav().click()
    expect(await page.locator('button button').count()).toBe(0)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    expect(errors).toEqual([])
    const dialogAnimations=motion.filter(item=>item.slot==='dialog-content')
    if(reducedMotion==='reduce')expect(dialogAnimations).toHaveLength(0)
    else expect(dialogAnimations.some(item=>item.options.duration===120)).toBe(true)
    results.push({width,reducedMotion,passed:true,errors,checks:['visible task list/header actions','no nested buttons','edit focus','draft cancellation','required title','sticky footer','save and reload','immutable run and goal evidence','delete cancel focus','dependency blocker','related task navigation focus','edit dependency','cancel deletion','delete persisted before success','deleted row removed','post-delete list focus','retained source shows deleted','viewport fits','shared dialog animation and reduced motion verified']})
    await page.close()
  }
  await writeFile(`${output}/qa.json`,JSON.stringify(results,null,2)+'\n')
  console.log(JSON.stringify(results))
} finally { await browser.close() }
