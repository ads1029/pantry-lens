import {unknownQuantity} from './core.js';
const netPattern=/(?:净\s*含\s*量|淨\s*含\s*量|净\s*重|淨\s*重|net\s*(?:weight|contents?|volume|wt\.?))\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*(千克|公斤|毫升|公升|克|升|kg|ml|g|l)(?![a-z])/ig;
const explicitName=/^(?:品名|产品名称|產品名稱|名称|名稱|product(?:\s*name)?|name)\s*[:：]\s*(.+)$/i;
const metadata=/^(?:配料|成分|营养|營養|保质|保質|生产|生產|储存|貯存|贮存|净|淨|net\b|ingredients?\b|nutrition\b|best\b|storage\b|opened\b|unopened\b|已开封|未开封|已開封|未開封)/i;
const normalizedUnit=u=>({g:'克',kg:'千克',ml:'毫升',l:'升','公斤':'千克','公升':'升'}[u.toLowerCase()]||u);
const sameColumn=(a,b)=>Math.abs((a.x+a.width/2)-(b.x+b.width/2))<Math.max(.12,(a.width+b.width)/2);
export function parsePackagingOCR(result,{photoIndex=0}={}){
 const lines=result.lines.filter(l=>l.text?.trim()&&l.box&&Number.isFinite(l.box.y));const candidates=[],usedNames=new Set();
 for(const line of lines){
  const matches=[...line.text.matchAll(netPattern)];
  for(const match of matches){
   const value=Number(match[1].replace(',','.'));if(!Number.isFinite(value)||value<=0)continue;
   const above=lines.filter(l=>l!==line&&l.box.y>=line.box.y-.005&&l.box.y-line.box.y<.2&&sameColumn(l.box,line.box));
   const names=above.map(l=>({line:l,explicit:l.text.match(explicitName)})).filter(n=>n.explicit||(!metadata.test(n.line.text)&&!new RegExp(netPattern.source,'i').test(n.line.text)));
   names.sort((a,b)=>Number(!!b.explicit)-Number(!!a.explicit)||Math.abs(a.line.box.y-line.box.y)-Math.abs(b.line.box.y-line.box.y));
   const prefix=line.text.slice(0,match.index).replace(/[\s:：,，;；-]+$/,'').trim();
   const inlineName=prefix&&!metadata.test(prefix)?(prefix.match(explicitName)?.[1]||prefix):'';
   const chosen=inlineName?{line,explicit:[null,inlineName]}:names[0],name=(chosen?.explicit?.[1]||chosen?.line.text||'').trim();
   if(chosen)usedNames.add(chosen.line);
   const below=lines.filter(l=>l!==line&&line.box.y-l.box.y>=-.005&&line.box.y-l.box.y<.10&&sameColumn(l.box,line.box));
   const status=below.find(l=>/(?:已开封|已開封|未开封|未開封|\bopened\b|\bunopened\b)/i.test(l.text));
   const opened=status?(/(?:未开封|未開封|\bunopened\b)/i.test(status.text)?'sealed':'opened'):'unknown';
   const evidence=[{kind:'local_ocr',text:line.text,confidence:line.confidence,box:line.box,photoIndex}];
   if(chosen&&chosen.line!==line)evidence.unshift({kind:'local_ocr',text:chosen.line.text,confidence:chosen.line.confidence,box:chosen.line.box,photoIndex});
   if(status)evidence.push({kind:'local_ocr',text:status.text,confidence:status.confidence,box:status.box,photoIndex});
   candidates.push({id:`ocr-${photoIndex}-${candidates.length}`,name,quantity:unknownQuantity(),packageNet:{value,unit:normalizedUnit(match[2]),source:'package_ocr',evidence:line.text},opened,evidence,uncertainties:[...(name?['包装名称来自邻近文字，请核对是否属于同一包装']:['未找到可靠包装名称，请命名或跳过']),'净含量不是当前剩余量；剩余数量/重量保留未知',...(matches.length>1?['同一文字行有多个净含量，可能关联不明，请逐项核对']:[]),...((line.confidence??0)<.7?['OCR 置信度偏低，请核对标签']:[])],location:'冷藏'});
  }
 }
 for(const line of lines){const nameMatch=line.text.match(explicitName);if(nameMatch&&!usedNames.has(line)&&!new RegExp(netPattern.source,'i').test(line.text))candidates.push({id:`ocr-${photoIndex}-${candidates.length}`,name:nameMatch[1].trim(),quantity:unknownQuantity(),packageNet:null,opened:'unknown',evidence:[{kind:'local_ocr',text:line.text,confidence:line.confidence,box:line.box,photoIndex}],uncertainties:['只读到包装名称，净含量与当前剩余量未知','包装名称来自 OCR，请核对或跳过'],location:'冷藏'});}
 return {provider:'apple-vision-local-ocr',isFixture:false,candidates,ocr:{engine:result.engine,photoIndex,width:result.width,height:result.height,lines},warnings:['真实 Apple Vision 本地 OCR；只提取标签文字。不能识别无标签食材、判断实际剩余量或准确估重。',...(candidates.length?[]:['没有读到带净含量标记的包装候选；可补拍清晰标签或改用文字草稿。'])]};
}
