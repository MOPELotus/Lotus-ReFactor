// Explicit physical-GPU verification, outside the ordinary unit-test glob.
import assert from 'node:assert/strict'
import {Canvas,FontLibrary} from 'skia-canvas'
import sharp from 'sharp'
import {resourcesPath} from '../core/path.js'
import path from 'node:path'
import {encodeGpuCanvas} from '../core/render/gpu-buffer.js'
FontLibrary.use('TileProof',[path.join(resourcesPath,'miao-theme/fonts/HYWH-65W.ttf')])
const canvas=new Canvas(360,17000),ctx=canvas.getContext('2d')
ctx.fillStyle='#25344b';ctx.fillRect(0,0,360,17000)
ctx.font='24px TileProof';ctx.textBaseline='top';ctx.fillStyle='#d3bc8e'
for(const y of [0,4000,8158,8189,8192,8210,16358,16384,16950]){
 ctx.fillText(`技能与天赋 · ${y}`,12,y)
 ctx.fillStyle='#46b6b4';ctx.beginPath();ctx.arc(295,y+22,26,0,Math.PI*2);ctx.fill();ctx.fillStyle='#d3bc8e'
}
const direct=canvas.toBufferSync('raw',{colorType:'rgba'})
const evidence=[]
const tiled=await encodeGpuCanvas(canvas,{imgType:'png',onTile(e){assert.equal(e.gpu,true);assert.equal(e.renderer,'GPU');assert.match(e.device,/RTX A4000/);evidence.push(e)}})
const decoded=await sharp(tiled.buffer,{limitInputPixels:false}).ensureAlpha().raw().toBuffer()
assert.equal(decoded.length,direct.length)
let changed=0,textChanges=0,maxDifference=0,totalDifference=0
for(let i=0;i<direct.length;i++){
 const delta=Math.abs(decoded[i]-direct[i]);if(!delta)continue
 const x=Math.floor(i/4)%360,y=Math.floor(i/(360*4))
 changed++;totalDifference+=delta;maxDifference=Math.max(maxDifference,delta)
 if(x<260)textChanges++
 // Different GPU surface origins can quantize the circle's antialias coverage
 // differently. Every changed pixel must stay on that curve's one-pixel edge.
 const onCircleEdge=[0,4000,8158,8189,8192,8210,16358,16384,16950].some(top=>Math.abs(Math.hypot(x+.5-295,y+.5-top-22)-26)<1.5)
 assert.ok(onCircleEdge,`A pixel away from an antialias edge changed at ${x},${y}`)
}
assert.equal(textChanges,0,'All text, including text crossing tile boundaries, must remain pixel-identical')
assert.ok(totalDifference/direct.length<0.001,'Tiling must preserve the rendered image within GPU antialias quantization')
assert.equal(tiled.tiles,3)
console.log(JSON.stringify({textPixelsIdentical:true,changedCurveEdgeChannels:changed,maxDifference,meanDifference:totalDifference/direct.length,width:canvas.width,height:canvas.height,tiles:tiled.tiles,hardware:evidence}))
