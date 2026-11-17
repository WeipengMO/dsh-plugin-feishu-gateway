import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readOpsSnapshot } from '../src/ops-read.mjs'

test('Gateway native compaction telemetry is validated and cannot expose summary text', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'feishu-native-compact-'))
  try {
    await writeFile(path.join(dir,'ops-runtime.json'),JSON.stringify({
      version:1,ts:Date.now(),workspace:dir,isolatedAgent:true,status:'ok',
      tasks:[],sessions:[],transport:{},stats:{},
      compaction:{
        available:true,completedInProcess:4,lastCompletedAt:Date.now()-2000,
        lastShadowedItems:19,lastShadowedTokens:12733,
        automaticCompletedInProcess:2,manualCompletedInProcess:1,
        unclassifiedCompletedInProcess:1,failedInProcess:3,
        lastAutoCompletedAt:Date.now()-3000,lastFailedAt:Date.now()-1000,
        lastTrigger:'automatic',
        summary:'PRIVATE SESSION SUMMARY',
        rawOutput:{tool:'NEVER EXPOSE'},
      }
    }))
    const result=await readOpsSnapshot(dir)
    assert.equal(result.compaction.available,true)
    assert.equal(result.compaction.completedInProcess,4)
    assert.equal(result.compaction.lastShadowedItems,19)
    assert.equal(result.compaction.automaticCompletedInProcess,2)
    assert.equal(result.compaction.manualCompletedInProcess,1)
    assert.equal(result.compaction.unclassifiedCompletedInProcess,1)
    assert.equal(result.compaction.failedInProcess,3)
    assert.equal(result.compaction.lastTrigger,'automatic')
    assert.ok(result.compaction.lastAutoCompletedAt>0)
    assert.ok(result.compaction.lastFailedAt>0)
    assert.ok(result.compaction.lastCompletedAt>0)
    assert.ok(!JSON.stringify(result).includes('PRIVATE'))
    assert.ok(!JSON.stringify(result).includes('NEVER EXPOSE'))
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('Invalid compaction counters cannot be coerced into reliable metrics',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'feishu-native-compact-bad-'))
  try{
    await writeFile(path.join(dir,'ops-runtime.json'),JSON.stringify({
      version:1,ts:Date.now(),workspace:dir,status:'ok',tasks:[],sessions:[],transport:{},stats:{},
      compaction:{available:false,completedInProcess:-99,lastShadowedTokens:'infinite',
        automaticCompletedInProcess:-12,manualCompletedInProcess:'3',
        failedInProcess:'private',lastTrigger:'<script>',lastAutoCompletedAt:-99},
    }))
    const result=await readOpsSnapshot(dir)
    assert.deepEqual(result.compaction,{available:false,completedInProcess:0,
      automaticCompletedInProcess:0,manualCompletedInProcess:0,
      unclassifiedCompletedInProcess:0,failedInProcess:0})
  }finally{await rm(dir,{recursive:true,force:true})}
})
