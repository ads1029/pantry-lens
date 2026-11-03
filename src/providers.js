import {unknownQuantity} from './core.js';
import {parsePackagingOCR} from './ocr-parser.js';
/** RecognitionProvider.analyze({photos: File[], description: string}) ->
 * {provider, isFixture, candidates:[{id,name,quantity:{min,max,unit,source},
 * packageNet:{value,unit,source:'package_ocr',evidence}|null, opened,
 * evidence:[{kind,text}], uncertainties:string[], location}] , warnings:string[]}
 * sources: unknown | visual_count | visual_estimate | scale | user.
 * packageNet is separate from remaining quantity. Never derive remaining from net.
 * Implementations must handle occlusion, multiple foods, unknowns and ranges.
 */
export class UnconnectedVisionProvider {
 async analyze(){throw Error('尚未接入无标签食材视觉识别。可切换本机 OCR 读取包装标签，或用文字创建草稿。');}
}
export class AppleVisionOCRProvider {
 async analyze({photos,description=''}){
  if(!photos?.length||photos.length>8)throw Error('请先选择 1–8 张包装标签照片');
  const allowed=['image/jpeg','image/png','image/webp','image/heic','image/heif'];
  if(photos.some(f=>!allowed.includes(f.type.toLowerCase())||!f.size||f.size>15*1024*1024))throw Error('本地 OCR 支持 JPG / PNG / WebP / HEIC / HEIF，每张不超过 15 MB');
  const results=[];
  for(const [photoIndex,file] of photos.entries()){
   const response=await fetch('/api/ocr',{method:'POST',headers:{'Content-Type':file.type,'X-Pantry-Local':'1'},body:file,signal:AbortSignal.timeout(45000)});
   const payload=await response.json();if(!response.ok)throw Error(`第 ${photoIndex+1} 张：${payload.error}${payload.detail?'（'+payload.detail+'）':''}`);
   results.push(parsePackagingOCR(payload,{photoIndex}));
  }
  return {provider:'apple-vision-local-ocr',isFixture:false,candidates:results.flatMap(r=>r.candidates),ocr:results.map(r=>r.ocr),warnings:[...new Set(results.flatMap(r=>r.warnings)),...(description.trim()?['补充文字仅保留为备注；可在候选内使用文字纠正。']:[])]};
 }
}
export class FixtureProvider {
 constructor(scenario='mixed'){this.scenario=scenario;}
 async analyze(){if(this.scenario==='weigh')return {provider:'fixture-weigh-v1',isFixture:true,warnings:['固定称重样例，与照片无关；未运行 AI / OCR。'],candidates:[
  {id:'pear',name:'梨',quantity:{min:420,max:420,unit:'克',source:'scale'},packageNet:null,opened:'unknown',evidence:[{kind:'fixture',text:'样例设定：秤盘只有梨、已去皮归零，显示 420g（未运行 OCR）'}],uncertainties:['需要确认秤读数只对应此食材；可修改或保留未知'],location:'冷藏'},
  {id:'potato',name:'土豆',quantity:{min:150,max:250,unit:'克',source:'visual_estimate'},packageNet:null,opened:'unknown',evidence:[{kind:'fixture',text:'样例范围 150–250g 仅用于演示；普通照片无法准确推出重量'}],uncertainties:['估计范围不具备测量准确性；建议留未知或补秤读数'],location:'常温'}
 ]};return {provider:'fixture-v1',isFixture:true,warnings:['固定候选数据，与上传照片无关；未运行 AI 或 OCR。'],candidates:[
  {id:'tomato',name:'番茄',quantity:{min:3,max:3,unit:'个',source:'visual_count'},packageNet:null,opened:'unknown',evidence:[{kind:'fixture',text:'样例设定：可见 3 个番茄；没有重量依据'}],uncertainties:['重量未知，按个记录即可'],location:'冷藏'},
  {id:'greens',name:'菠菜',quantity:unknownQuantity(),packageNet:null,opened:'unknown',evidence:[{kind:'fixture',text:'样例设定：叶菜部分遮挡，无法判断重量'}],uncertainties:['种类可能有误，可纠正或跳过','数量与重量未知'],location:'冷藏'},
  {id:'tofu',name:'豆腐',quantity:unknownQuantity(),packageNet:{value:300,unit:'克',source:'package_ocr',evidence:'样例标签文字：净含量 300g（未运行 OCR）'},opened:'opened',evidence:[{kind:'fixture',text:'样例设定：包装已开封，标签标有净含量'}],uncertainties:['开封后剩余重量未知；300g 只保存为包装净含量'],location:'冷藏'},
  {id:'hidden',name:'',quantity:unknownQuantity(),packageNet:null,opened:'unknown',evidence:[{kind:'fixture',text:'样例设定：袋内遮挡，无法识别'}],uncertainties:['无法识别；默认跳过'],location:'冷冻'}
 ]};}
}
export class ManualProvider {
 async analyze({description}){if(!description.trim())throw Error('请填写文字，例如：番茄 3个；菠菜 未知');const {correctCandidate}=await import('./core.js');return {provider:'manual-parser',isFixture:false,warnings:['仅按固定格式解析文字，未识别照片。'],candidates:description.split(/[；;\n]+/).filter(t=>t.trim()).map((t,i)=>correctCandidate({id:'manual-'+i,name:'',quantity:unknownQuantity(),packageNet:null,opened:'unknown',evidence:[],uncertainties:[],location:'冷藏'},t))};}
}
