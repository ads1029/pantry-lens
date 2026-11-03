import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parsePackagingOCR} from '../src/ocr-parser.js';
import {unknownQuantity} from '../src/core.js';
import {detectImage,MAX_IMAGE_BYTES} from '../local-ocr.mjs';
import {isLocalRequest} from '../server.mjs';
test('真实 OCR 记录重放：中英文六包装候选与净含量，剩余均未知',async()=>{
 const evidence=JSON.parse(await readFile(new URL('../docs/ocr-evidence.json',import.meta.url),'utf8'));
 const result=parsePackagingOCR(evidence.raw);
 assert.deepEqual(result.candidates.map(c=>[c.name,c.packageNet.value,c.packageNet.unit]),[['嫩豆腐',300,'克'],['Rolled Oats',.5,'千克'],['大米',2,'千克'],['Yogurt',125,'克'],['豆乳',250,'毫升'],['Apple Juice',330,'毫升']]);
 for(const c of result.candidates){assert.deepEqual(c.quantity,unknownQuantity());assert.ok(c.evidence.every(e=>e.kind==='local_ocr'));assert.ok(c.packageNet.evidence);}
 assert.equal(result.candidates[0].opened,'opened');assert.equal(result.candidates[2].opened,'sealed');
 const line=(text,y)=>({text,confidence:.9,box:{x:.1,y,width:.3,height:.04}});
 assert.equal(parsePackagingOCR({lines:[line('Protein 25g per 100g',.8),line('420g',.7)]}).candidates.length,0);
 const missing=parsePackagingOCR({lines:[line('Product: Milk',.8)]}).candidates[0];assert.equal(missing.packageNet,null);assert.deepEqual(missing.quantity,unknownQuantity());
 const inline=parsePackagingOCR({lines:[line('品名：牛奶 净含量：500ml',.8)]}).candidates[0];assert.equal(inline.name,'牛奶');assert.equal(inline.packageNet.value,500);
});
test('输入边界：类型/内容不符、超限、跨源与非本机 Host 被拒绝',async()=>{
 const png=await readFile(new URL('../docs/synthetic-labels.png',import.meta.url));assert.equal(detectImage(png,'image/png'),'png');
 for(const [bytes,mime] of [[png,'image/jpeg'],[Buffer.from('<svg/>'),'image/svg+xml'],[Buffer.alloc(MAX_IMAGE_BYTES+1),'image/png'],[Buffer.alloc(0),'image/png']])assert.throws(()=>detectImage(bytes,mime));
 const req=(host,origin,token='1')=>({headers:{host,origin,'x-pantry-local':token}});
 assert.equal(isLocalRequest(req('127.0.0.1:4173','http://127.0.0.1:4173')),true);
 assert.equal(isLocalRequest(req('127.0.0.1:4173','http://evil.example')),false);assert.equal(isLocalRequest(req('evil.example:4173',undefined)),false);assert.equal(isLocalRequest(req('127.0.0.1:4173',undefined,'')),false);
});
