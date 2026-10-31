import test from 'node:test'
import assert from 'node:assert/strict'
import {notifyUser} from '../core/transport/notify.js'

test('private-only notifications never enumerate or send to groups when the user is not a friend',async()=>{
 const bot={fl:new Map(),getGroupList:()=>{throw new Error('Must not enumerate groups')},pickGroup:()=>{throw new Error('Must not send to groups')}}
 const result=await notifyUser('123','private exchange result',{bot,prefer:'private',allowGroupFallback:false,fallbackGroups:['456']})
 assert.equal(result.ok,false)
 assert.equal(result.reason,'not_friend')
 assert.deepEqual(result.attempts.map(item=>item.channel),['private'])
})

test('private-only notifications keep private delivery failures private',async()=>{
 const bot={fl:new Map([[123,{}]]),pickUser:()=>({sendMsg:async()=>{throw new Error('private delivery failed')}}),getGroupList:()=>{throw new Error('Must not enumerate groups')}}
 const result=await notifyUser('123','private exchange result',{bot,prefer:'private',allowGroupFallback:false})
 assert.equal(result.ok,false)
 assert.equal(result.reason,'private delivery failed')
 assert.equal(result.attempts.length,1)
})

test('existing notifications retain group fallback unless explicitly disabled',async()=>{
 const sent=[]
 const bot={fl:new Map(),gml:new Map([[456,new Map([[123,{}]])]]),pickGroup:()=>({sendMsg:async payload=>{sent.push(payload)}})}
 const result=await notifyUser('123','ordinary notification',{bot,prefer:'private',at:false})
 assert.equal(result.ok,true)
 assert.equal(result.channel,'group')
 assert.deepEqual(sent,['ordinary notification'])
})
