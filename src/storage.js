import {emptyState} from './core.js';
// IndexedDB read/write transactions serialize commits across tabs, including on LAN HTTP.
// Implement read() / transact(syncTransform) to replace with another local adapter.
export class IndexedDBRepository {
 constructor(){this.database=new Promise((resolve,reject)=>{const req=indexedDB.open('pantry-lens',1);req.onupgradeneeded=()=>req.result.createObjectStore('state');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('请关闭旧版原型页面后重试'));});}
 async read(){const db=await this.database;return new Promise((resolve,reject)=>{const req=db.transaction('state','readonly').objectStore('state').get('inventory');req.onsuccess=()=>{const s=req.result||emptyState();if(s.schemaVersion!==1||!Array.isArray(s.batches)||!Array.isArray(s.events))reject(Error('本地数据格式不兼容，请先导出备份'));else resolve(s);};req.onerror=()=>reject(req.error);});}
 async transact(transform){const db=await this.database;return new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite'),store=tx.objectStore('state'),req=store.get('inventory');let next,problem;req.onsuccess=()=>{try{next=transform(req.result||emptyState());store.put(next,'inventory');}catch(e){problem=e;tx.abort();}};tx.oncomplete=()=>resolve(next);tx.onerror=()=>reject(problem||tx.error);tx.onabort=()=>reject(problem||tx.error||Error('本地保存未完成'));});}
}
