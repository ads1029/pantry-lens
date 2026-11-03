// End-to-end local HTTP -> temp image -> actual Vision -> parser -> inventory checks.
// Uses only the clearly artificial docs/synthetic-labels.png, never user photos.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {createPantryServer} from '../server.mjs';
import {parsePackagingOCR} from '../src/ocr-parser.js';
import {emptyState,prepareDraft,commitDraft,unknownQuantity} from '../src/core.js';
import {MAX_IMAGE_BYTES} from '../local-ocr.mjs';
const server=createPantryServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,headers={'Content-Type':'image/png','X-Pantry-Local':'1'},image=await readFile(new URL('../docs/synthetic-labels.png',import.meta.url));
const priorTemps=(await readdir(tmpdir())).filter(n=>n.startsWith('pantry-lens-ocr-')).sort();
try{
 const response=await fetch(base+'/api/ocr',{method:'POST',headers:{...headers,'X-Filename':'../../should-never-be-used.png'},body:image});
 const raw=await response.json();assert.equal(response.status,200,JSON.stringify(raw));
 const parsed=parsePackagingOCR(raw);
 assert.deepEqual(parsed.candidates.map(c=>[c.name,c.packageNet.value,c.packageNet.unit]),[['嫩豆腐',300,'克'],['Rolled Oats',.5,'千克'],['大米',2,'千克'],['Yogurt',125,'克'],['豆乳',250,'毫升'],['Apple Juice',330,'毫升']]);
 const draft=prepareDraft(parsed.candidates,emptyState(),'purchase'),saved=commitDraft(emptyState(),draft).state;
 assert.equal(saved.batches.length,6);for(const b of saved.batches)assert.deepEqual(b.quantity,unknownQuantity());assert.equal(commitDraft(saved,draft).state.batches.length,6);
 const statuses={};
 statuses.wrongMime=(await fetch(base+'/api/ocr',{method:'POST',headers:{...headers,'Content-Type':'image/jpeg'},body:image})).status;assert.equal(statuses.wrongMime,415);
 statuses.svg=(await fetch(base+'/api/ocr',{method:'POST',headers:{...headers,'Content-Type':'image/svg+xml'},body:'<svg/>'})).status;assert.equal(statuses.svg,415);
 statuses.corruptImage=(await fetch(base+'/api/ocr',{method:'POST',headers,body:image.subarray(0,16)})).status;assert.equal(statuses.corruptImage,422);
 statuses.oversized=await new Promise((resolve,reject)=>{const r=http.request(base+'/api/ocr',{method:'POST',headers:{...headers,'Content-Length':String(MAX_IMAGE_BYTES+1)}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end(Buffer.from('x'));});assert.equal(statuses.oversized,413);
 statuses.crossOrigin=(await fetch(base+'/api/ocr',{method:'POST',headers:{...headers,Origin:'http://evil.example'},body:image})).status;assert.equal(statuses.crossOrigin,403);
 statuses.userPath=(await fetch(base+'/api/ocr?path=/etc/passwd',{method:'POST',headers,body:image})).status;assert.equal(statuses.userPath,404);
 for(const p of ['/server.mjs','/local-ocr.mjs','/native/ocr.swift','/.cache/pantry-ocr','/src/../../etc/passwd'])assert.equal((await fetch(base+p)).status,404,p);
 assert.deepEqual((await readdir(tmpdir())).filter(n=>n.startsWith('pantry-lens-ocr-')).sort(),priorTemps);
 const evidence={testImage:'人工生成标签，非用户照片',imageSHA256:createHash('sha256').update(image).digest('hex'),execution:'Actual Apple Vision via local HTTP API; no external service',at:new Date().toISOString(),raw,parsed,checks:{candidateCount:6,allRemainingUnknown:true,repeatCommitBatchCount:6,temporaryFilesCleaned:true,statuses}};
 await writeFile(new URL('../docs/ocr-evidence.json',import.meta.url),JSON.stringify(evidence,null,2));
 console.log('真实本地 OCR 通过：人工标签图片 → HTTP → Apple Vision → 6 个包装候选 → 入库（剩余均未知）');
 console.log(parsed.candidates.map(c=>`${c.name}: ${c.packageNet.value}${c.packageNet.unit}，${c.opened}，剩余未知`).join('\n'));
 console.log('安全边界:',JSON.stringify(statuses),'；临时图片全部清理；静态路径未暴露服务端文件');
}finally{await new Promise(resolve=>server.close(resolve));server.closeAllConnections();}
