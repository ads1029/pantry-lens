export const emptyState=()=>({schemaVersion:1,revision:0,batches:[],events:[]});
export const unknownQuantity=()=>({min:null,max:null,unit:'未知',source:'unknown'});
const uuid=()=>globalThis.crypto.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=crypto.getRandomValues(new Uint8Array(1))[0]%16;return(c==='x'?n:(n&3)|8).toString(16);});
export function validateQuantity(q){
 if(!q||!['unknown','visual_count','visual_estimate','scale','user'].includes(q.source))throw Error('数量来源无效');
 if(q.min===null&&q.max===null)return;
 if(!Number.isFinite(q.min)||!Number.isFinite(q.max)||q.min<0||q.max<q.min||!q.unit||q.unit==='未知')throw Error('请填写有效数量或范围，或留空保留未知');
}
export function correctCandidate(candidate,text){
 // Deliberately small deterministic text override, never presented as AI.
 const normalized=text.trim();
 if(!normalized)return candidate;
 const match=normalized.match(/^(.+?)\s+(\d+(?:\.\d+)?)(?:\s*[-~～至]\s*(\d+(?:\.\d+)?))?\s*(g|kg|克|千克|公斤|毫升|ml|升|l|个|颗|根|袋|盒|包|瓶|把)\s*$/i);
 const unknown=normalized.match(/^(.+?)\s+(?:未知|重量未知|剩余未知)$/);
 if(!match&&!unknown)throw Error('纠正格式：番茄 3个、菠菜 100-200克，或菠菜 未知');
 const q=match?{min:Number(match[2]),max:Number(match[3]||match[2]),unit:match[4],source:'user'}:unknownQuantity();
 validateQuantity(q);
 return {...candidate,name:(match||unknown)[1].trim(),quantity:q,evidence:[...candidate.evidence,{kind:'user',text:`文字纠正：${normalized}`}],uncertainties:[],correction:normalized};
}
export function prepareDraft(candidates,state,mode,photoHash=null){
 return {id:uuid(),mode,photoHash,candidates:candidates.map(c=>({...structuredClone(c),selected:!!c.name,target:mode==='purchase'&&!state.batches.some(b=>b.name===c.name)?'new':''}))};
}
export function commitDraft(state,draft){
 if(state.events.some(e=>e.id===draft.id))return {state,duplicate:true};
 const photoHashes=Array.isArray(draft.photoHash)?draft.photoHash:[draft.photoHash].filter(Boolean);
 if(photoHashes.length&&state.events.some(e=>{const prior=Array.isArray(e.photoHash)?e.photoHash:[e.photoHash];return photoHashes.some(h=>prior.includes(h));}))throw Error('其中有照片已经入库（含已撤销记录）。请盘点对应批次或重新拍摄。');
 if(!['purchase','stocktake'].includes(draft.mode))throw Error('入库模式无效');
 const rows=draft.candidates.filter(c=>c.selected);
 if(!rows.length)throw Error('至少选择一种食材');
 const next=structuredClone(state),before=structuredClone(state.batches),now=new Date().toISOString(),touched=new Set();
 for(const row of rows){
  if(!row.name.trim())throw Error('未识别食材请命名或取消选择');
  validateQuantity(row.quantity);
  if(!row.target)throw Error(`请确认「${row.name}」对应新批次还是已有批次`);
  if(row.target==='new'&&state.batches.some(b=>b.name===row.name.trim())&&!row.confirmedNew)throw Error(`已有「${row.name}」，请明确确认独立新批次`);
  if(row.target!=='new'&&draft.mode==='purchase')throw Error('新增购买请建立新批次；更新现有数量请使用盘点');
  const old=row.target==='new'?null:next.batches.find(b=>b.id===row.target);
  if(row.target!=='new'&&!old)throw Error('目标批次已不存在，请重新选择');
  if(old&&touched.has(old.id))throw Error('同一批次不能在一次盘点中重复更新');
  if(old)touched.add(old.id);
  const batch={id:old?.id||uuid(),name:row.name.trim(),quantity:structuredClone(row.quantity),packageNet:row.packageNet||null,opened:row.opened??'unknown',location:row.location||'冷藏',evidence:structuredClone(row.evidence),uncertainties:row.uncertainties||[],note:row.note||'',createdAt:old?.createdAt||now,updatedAt:now,originMode:old?.originMode||draft.mode};
  if(old)next.batches[next.batches.findIndex(b=>b.id===old.id)]=batch;else next.batches.push(batch);
 }
 next.revision++;
 next.events.push({id:draft.id,photoHash:draft.photoHash,mode:draft.mode,at:now,before,afterRevision:next.revision,undone:false});
 return {state:next,duplicate:false};
}
export function undoLast(state){
 const last=state.events.at(-1);
 if(!last||last.undone||last.afterRevision!==state.revision)throw Error('没有可撤销的最近入库');
 const next=structuredClone(state);next.batches=structuredClone(last.before);next.revision++;next.events.at(-1).undone=true;return next;
}
export function quantityLabel(q){return q.min===null?'数量 / 重量未知':`${q.min===q.max?q.min:q.min+'–'+q.max} ${q.unit}`;}
