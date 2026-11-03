import {prepareDraft,commitDraft,undoLast,correctCandidate,quantityLabel,unknownQuantity} from './core.js';
import {IndexedDBRepository} from './storage.js';
import {photoDigest} from './fingerprint.js';
import {FixtureProvider,ManualProvider,UnconnectedVisionProvider,AppleVisionOCRProvider} from './providers.js';
const $=s=>document.querySelector(s),repo=new IndexedDBRepository();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sources={unknown:'未知',visual_count:'视觉计数',visual_estimate:'视觉估计范围',scale:'可见秤读数',user:'用户填写'};
let mode='purchase',files=[],draft=null,photoHash=null,state,requestVersion=0;
try{state=await repo.read();}catch(e){state={batches:[],events:[]};message(e.message);$('#analyze').disabled=true;}
let previewURLs=[];
function message(text){$('#status').textContent=text;$('#status').hidden=false;clearTimeout(message.timer);message.timer=setTimeout(()=>$('#status').hidden=true,6500);}
function error(e){message(e.message||String(e));}
function clearDraft(){requestVersion++;draft=null;$('#commit-area').hidden=true;$('#candidate-count').textContent='等待草稿';$('#review-content').className='empty-review';$('#review-content').innerHTML='<div class="outline-bowl">⌒</div><h3>等待新的候选草稿</h3><p>照片与补充文字准备好后，点击生成。</p>';}
for(const type of ['purchase','stocktake'])$('#'+type).onclick=()=>{mode=type;for(const t of ['purchase','stocktake'])$('#'+t).classList.toggle('active',t===type);$('#mode-help').textContent=type==='purchase'?'每次购买保留独立批次；遇到同名食材需要确认。':'记录当前剩余数量，覆盖选定批次；不会自动增加库存。';clearDraft();};
async function selectFiles(event){
 try{
  const picked=[...event.target.files];
  if(!picked.length)return;
  if(picked.length>8||picked.some(f=>!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(f.type.toLowerCase())||!f.size||f.size>15*1024*1024))throw Error('最多 8 张 JPG / PNG / WebP / HEIC / HEIF，每张不超过 15 MB。');
  for(const url of previewURLs)URL.revokeObjectURL(url);previewURLs=[];files=picked;photoHash=null;
  $('#previews').innerHTML=files.map(f=>{const url=URL.createObjectURL(f);previewURLs.push(url);return `<figure><img src="${url}" alt="${esc(f.name)}"><figcaption>${esc(f.name)}</figcaption></figure>`;}).join('')+'<button class="text-button" id="remove-photos">清除照片</button>';
  $('#remove-photos').onclick=()=>{for(const url of previewURLs)URL.revokeObjectURL(url);previewURLs=[];files=[];photoHash=null;$('#previews').innerHTML='';$('#camera').value='';$('#photos').value='';clearDraft();};clearDraft();
 }catch(e){error(e);}finally{event.target.value='';}
}
$('#photos').onchange=selectFiles;$('#camera').onchange=selectFiles;
$('#description').oninput=()=>{if(draft)clearDraft();};
$('#provider').onchange=()=>{clearDraft();$('#provider-help').textContent={'local-ocr':'照片仅发送到这台 Mac 的 Apple Vision OCR。临时原图完成后删除，不外传。只读包装标签，净含量不代表剩余量。',fixture:'样例与上传照片无关，未调用 AI / OCR。真实照片只在浏览器中预览，不上传、不保存。','fixture-weigh':'固定设定的秤读数与视觉估计范围，不代表识别了照片。可清空数值留未知。',manual:'固定格式文字解析，不调用 AI。支持：番茄 3个；菠菜 未知；土豆 2-4个。',vision:'无标签食材视觉识别尚未接入。不会调用外部 AI；目前只可本地预览。'}[$('#provider').value];};
async function fingerprint(selectedPhotos){
 if(!selectedPhotos.length)return null;
 const hashes=await Promise.all(selectedPhotos.map(async f=>photoDigest(await f.arrayBuffer())));
 return hashes.sort();
}
$('#analyze').onclick=async()=>{
 const run=++requestVersion,selectedPhotos=[...files],selectedMode=mode,key=$('#provider').value,description=$('#description').value;
 $('#analyze').disabled=true;
 $('#analyze').textContent=key==='local-ocr'?'正在本机读取包装文字…':'正在生成草稿…';
 try{
  state=await repo.read();
  const hashes=await fingerprint(selectedPhotos);
  const provider=key==='local-ocr'?new AppleVisionOCRProvider():key.startsWith('fixture')?new FixtureProvider(key==='fixture-weigh'?'weigh':'mixed'):key==='manual'?new ManualProvider():new UnconnectedVisionProvider();
  const result=await provider.analyze({photos:selectedPhotos,description});
  if(run!==requestVersion)return;
  photoHash=hashes;draft=prepareDraft(result.candidates,state,selectedMode,hashes);draft.provider=result.provider;draft.isFixture=result.isFixture;draft.ocr=result.ocr;
  for(const c of draft.candidates)c.note=description;
  renderDraft();message(result.warnings.join(' '));
 }catch(e){if(run===requestVersion)error(e);}finally{$('#analyze').disabled=false;$('#analyze').textContent='生成候选草稿 →';}
};
function renderDraft(){
 $('#candidate-count').textContent=`${draft.candidates.length} 项 · ${draft.isFixture?'固定样例':draft.ocr?'本机 OCR':'文字草稿'}`;
 $('#review-content').className='candidate-list';
 $('#review-content').innerHTML=draft.candidates.map((c,i)=>{
  const matching=state.batches.filter(b=>b.name===c.name);
  const options=`<option value="">${mode==='stocktake'?'选择对应批次或新发现':'确认是否为新批次'}</option><option value="new" ${c.target==='new'?'selected':''}>${matching.length?'确认：独立新批次':'建立新批次'}</option>`+(mode==='stocktake'?matching.map(b=>`<option value="${esc(b.id)}" ${c.target===b.id?'selected':''}>${esc(b.name)} · ${esc(quantityLabel(b.quantity))} · ${esc(b.location)} · ${esc(b.id.slice(0,6))}</option>`).join(''):'');
  return `<article class="candidate ${c.selected?'':'excluded'}" data-index="${i}"><div class="candidate-heading"><label class="candidate-select"><input type="checkbox" data-field="selected" ${c.selected?'checked':''}><span>${String(i+1).padStart(2,'0')}</span><strong>${esc(c.name||'未识别食材')}</strong></label><span class="source-badge">${draft.isFixture?'样例 · ':''}${esc(sources[c.quantity.source])}</span></div><details ${!c.name?'open':''}><summary>编辑名称、数量或范围</summary><label class="field-label">食材名称<input data-field="name" value="${esc(c.name)}" placeholder="命名后再选择入库"></label><div class="quantity-inputs"><label>最小值<input data-field="min" type="number" min="0" step="any" value="${c.quantity.min??''}" placeholder="未知"></label><span>—</span><label>最大值<input data-field="max" type="number" min="0" step="any" value="${c.quantity.max??''}" placeholder="同最小值"></label><label>单位<input data-field="unit" value="${esc(c.quantity.unit==='未知'?'':c.quantity.unit)}" placeholder="个 / 克"></label></div><p class="helper">留空保留未知。修改数量记为用户填写；视觉估重需保留范围。</p><label class="field-label">文字纠正<div class="correction"><input data-field="correctionText" placeholder="例如：青菜 2把 / 青菜 未知"><button type="button" data-action="correct" class="secondary small">应用</button></div></label></details><div class="quantity-display">${esc(quantityLabel(c.quantity))}</div>${c.packageNet?`<p class="package-net">包装净含量 ${esc(c.packageNet.value)} ${esc(c.packageNet.unit)} · ${c.opened==='opened'?'已开封':c.opened==='sealed'?'未开封':'开封状态未知'}<br><small>${esc(c.packageNet.evidence)}；不能代替剩余重量。</small></p>`:''}<p class="evidence">${c.evidence.map(e=>esc(e.text)).join('；')}</p>${c.uncertainties.length?`<p class="uncertainty">${c.uncertainties.map(esc).join(' · ')}</p>`:''}<div class="row-options"><label>存放位置<select data-field="location">${['冷藏','冷冻','常温','其他'].map(v=>`<option ${c.location===v?'selected':''}>${v}</option>`).join('')}</select></label><label class="batch-target">${mode==='stocktake'?'盘点目标':'购买批次'}<select data-field="target">${options}</select></label></div></article>`;
 }).join('')+(draft.ocr?`<details class="raw-ocr"><summary>查看原始 OCR 文字与置信度</summary>${draft.ocr.map(r=>`<h4>照片 ${r.photoIndex+1} · ${esc(r.engine)}</h4><pre>${r.lines.map(l=>esc(l.text)+' ['+Math.round(l.confidence*100)+'%]').join('\n')||'未读到文字'}</pre>`).join('')}<p class="helper">只解析带「净含量 / 净重 / Net weight / Net contents」标记的标签。营养表、无标签食材与秤数字不自动入库。</p></details>`:'');
 $('#commit-area').hidden=false;$('#review-help').textContent=draft.isFixture?'演示候选会作为标记清晰的样例记录保存。未知重量可以直接保留。':'只保存所选项；未选项跳过。重量可留未知。';
 $('#commit').disabled=!draft.candidates.length;$('#commit').textContent='确认所选并入库';
}
$('#review-content').addEventListener('change',e=>{
 if(!draft||!e.target.dataset.field)return;
 const row=e.target.closest('[data-index]'),c=draft.candidates[Number(row.dataset.index)],field=e.target.dataset.field;
 if(field==='selected'){c.selected=e.target.checked;row.classList.toggle('excluded',!c.selected);}
 else if(field==='name'){c.name=e.target.value.trim();c.target=mode==='purchase'&&!state.batches.some(b=>b.name===c.name)?'new':'';c.confirmedNew=false;renderDraft();}
 else if(['min','max','unit'].includes(field)){
  const min=row.querySelector('[data-field=min]').value,max=row.querySelector('[data-field=max]').value,unit=row.querySelector('[data-field=unit]').value.trim();
  c.quantity=min===''&&max===''?unknownQuantity():{min:min===''?null:Number(min),max:max===''?(min===''?null:Number(min)):Number(max),unit,source:'user'};
  row.querySelector('.quantity-display').textContent=quantityLabel(c.quantity);row.querySelector('.source-badge').textContent=(draft.isFixture?'样例 · ':'')+sources[c.quantity.source];
 }else if(field==='target'){c.target=e.target.value;c.confirmedNew=c.target==='new';}
 else if(field!=='correctionText')c[field]=e.target.value;
});
$('#review-content').addEventListener('click',e=>{
 if(e.target.dataset.action!=='correct')return;
 try{const row=e.target.closest('[data-index]'),i=Number(row.dataset.index);const c=correctCandidate(draft.candidates[i],row.querySelector('[data-field=correctionText]').value);c.target=mode==='purchase'&&!state.batches.some(b=>b.name===c.name)?'new':'';c.confirmedNew=false;draft.candidates[i]=c;renderDraft();message('已应用文字纠正，来源记为用户填写。');}catch(e){error(e);}
});
$('#commit').onclick=async()=>{
 if(!draft)return;
 $('#commit').disabled=true;
 try{const captured=structuredClone(draft);state=await repo.transact(current=>commitDraft(current,captured).state);renderInventory();$('#commit').textContent='已入库 ✓';message('已保存到本地，可撤销最近一次入库。');}catch(e){$('#commit').disabled=false;error(e);}
};
function renderInventory(){
 $('#inventory-count').textContent=`${state.batches.length} 个批次`;
 $('#undo').disabled=!state.events.length||state.events.at(-1).undone;
 $('#inventory-content').innerHTML=state.batches.length?`<div class="inventory-grid">${state.batches.map(b=>`<article class="batch"><div class="batch-top"><span class="food-symbol">${b.name.includes('番茄')?'●':'✳'}</span><span>${esc(b.location)}</span></div><h3>${esc(b.name)}</h3><strong>${esc(quantityLabel(b.quantity))}</strong><p>${esc(sources[b.quantity.source])}${b.evidence.some(e=>e.kind==='fixture')?' · 演示样例':''}</p><small>批次 ${esc(b.id.slice(0,6))} · ${esc(new Date(b.updatedAt).toLocaleString('zh-CN'))}</small>${b.packageNet?`<p class="helper">包装净含量 ${esc(b.packageNet.value)} ${esc(b.packageNet.unit)}；非剩余重量</p>`:''}${b.note?`<p class="helper">备注：${esc(b.note)}</p>`:''}</article>`).join('')}</div>`:'<div class="inventory-empty"><span>◌</span><p>冰箱的故事，从第一份食材开始。</p><small>目前没有库存，也不会从旧聊天导入。</small></div>';
}
$('#undo').onclick=async()=>{try{state=await repo.transact(undoLast);renderInventory();clearDraft();message('最近一次入库已撤销；保留照片指纹以避免误重复提交。');}catch(e){error(e);}};
$('#export').onclick=async()=>{try{const blob=new Blob([JSON.stringify(await repo.read(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='pantry-lens-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){error(e);}};
$('#about').onclick=e=>{e.preventDefault();message('本机原型 v0.5：AI 优先从家常菜谱库挑选三道，匹配不足时现场生成，使用现有账号登录及额度。另保留 Apple Vision 包装 OCR 与库存功能。食谱请求保存在本机，生成时食材与偏好会发给模型服务；照片不随食谱发送。');};
window.addEventListener('focus',async()=>{try{state=await repo.read();renderInventory();}catch(e){error(e);}});
renderInventory();
