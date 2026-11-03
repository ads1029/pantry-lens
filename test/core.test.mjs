import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyState,prepareDraft,commitDraft,correctCandidate,undoLast,unknownQuantity} from '../src/core.js';
import {FixtureProvider,ManualProvider,UnconnectedVisionProvider} from '../src/providers.js';
import {sha256Fallback} from '../src/fingerprint.js';
import {createHash} from 'node:crypto';
const fixture=await new FixtureProvider().analyze();
test('照片指纹在手机 HTTP 回退与原生 SHA-256 结果一致',()=>{for(const value of ['', 'abc', '番茄照片', 'x'.repeat(100000)])assert.equal(sha256Fallback(new TextEncoder().encode(value)),createHash('sha256').update(value).digest('hex'));});
test('草稿和文字修正不改变库存；未知重量和净含量分开保留',()=>{
 const state=emptyState(),snapshot=structuredClone(state),draft=prepareDraft(fixture.candidates,state,'purchase');
 draft.candidates[0]=correctCandidate(draft.candidates[0],'小番茄 4个');
 assert.deepEqual(state,snapshot);
 const next=commitDraft(state,draft).state;
 assert.equal(next.batches.length,3);assert.equal(next.batches[0].name,'小番茄');assert.equal(next.batches[0].quantity.min,4);
 assert.deepEqual(next.batches[2].quantity,unknownQuantity());assert.equal(next.batches[2].packageNet.value,300);
 assert.equal(next.batches[2].opened,'opened');assert.deepEqual(state,snapshot);
});
test('重复确认不重复入库；同照片新草稿和多图交集均被拦截',()=>{
 const draft=prepareDraft(fixture.candidates,emptyState(),'purchase',['photo-a','photo-b']);
 const first=commitDraft(emptyState(),draft).state;
 assert.deepEqual(commitDraft(first,draft),{state:first,duplicate:true});
 const duplicate=prepareDraft(fixture.candidates,first,'purchase',['photo-b','photo-c']);
 assert.throws(()=>commitDraft(first,duplicate),/照片已经入库/);
});
test('盘点必须选择批次，覆盖剩余而非增加；同名购买必须确认',()=>{
 const original=commitDraft(emptyState(),prepareDraft([fixture.candidates[0]],emptyState(),'purchase')).state;
 const inventory=prepareDraft([fixture.candidates[0]],original,'stocktake');
 assert.throws(()=>commitDraft(original,inventory),/请确认/);
 inventory.candidates[0].target=original.batches[0].id;inventory.candidates[0].quantity={min:1,max:2,unit:'个',source:'user'};
 const next=commitDraft(original,inventory).state;
 assert.equal(next.batches.length,1);assert.equal(next.batches[0].quantity.min,1);assert.equal(next.batches[0].quantity.max,2);
 const purchase=prepareDraft([fixture.candidates[0]],next,'purchase');
 assert.throws(()=>commitDraft(next,purchase),/请确认/);purchase.candidates[0].target='new';
 assert.throws(()=>commitDraft(next,purchase),/明确确认/);purchase.candidates[0].confirmedNew=true;
 assert.equal(commitDraft(next,purchase).state.batches.length,2);
 assert.deepEqual(undoLast(next).batches,original.batches);
});
test('文字纠正保留用户来源；部分遮挡跳过、范围有效、无真AI假成功',async()=>{
 const r=await new ManualProvider().analyze({description:'菠菜 未知；土豆 2-4个'});
 assert.equal(r.candidates[0].quantity.min,null);assert.equal(r.candidates[1].quantity.max,4);assert.equal(r.candidates[1].quantity.source,'user');
 const draft=prepareDraft(fixture.candidates,emptyState(),'purchase');assert.equal(draft.candidates.at(-1).selected,false);
 draft.candidates[0].quantity={min:4,max:2,unit:'个',source:'user'};assert.throws(()=>commitDraft(emptyState(),draft),/有效数量/);
 await assert.rejects(new UnconnectedVisionProvider().analyze({photos:[]}),/尚未接入/);assert.equal(fixture.isFixture,true);
});
test('撤销后不能靠重复点击或同照片重新入库',()=>{
 const draft=prepareDraft(fixture.candidates,emptyState(),'purchase',['photo']);const saved=commitDraft(emptyState(),draft).state,undone=undoLast(saved);
 assert.equal(undone.batches.length,0);assert.equal(commitDraft(undone,draft).duplicate,true);
 assert.throws(()=>commitDraft(undone,prepareDraft(fixture.candidates,undone,'purchase',['photo'])),/照片已经入库/);
 assert.throws(()=>undoLast(undone),/没有可撤销/);
});
