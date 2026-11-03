import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),root=fileURLToPath(new URL('.',import.meta.url));
export const MAX_IMAGE_BYTES=15*1024*1024;
export class OCRInputError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export function detectImage(bytes,mime){
 if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw new OCRInputError('图片为空或超过 15 MB',413);
 const type=mime?.split(';')[0].trim().toLowerCase();let actual,extension;
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){actual='image/png';extension='png';}
 else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){actual='image/jpeg';extension='jpg';}
 else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){actual='image/webp';extension='webp';}
 else if(bytes.toString('ascii',4,8)==='ftyp'&&['heic','heix','hevc','hevx','mif1','msf1'].includes(bytes.toString('ascii',8,12))){actual=type==='image/heif'?'image/heif':'image/heic';extension='heic';}
 if(!actual||actual!==type)throw new OCRInputError('仅支持内容与类型一致的 JPG / PNG / WebP / HEIC / HEIF 图片',415);
 return extension;
}
let compiling;
export async function ensureOCR(){
 if(process.platform!=='darwin')throw new Error('Apple Vision OCR 仅在 macOS 可运行');
 if(compiling)return compiling;
 compiling=(async()=>{
  const source=path.join(root,'native/ocr.swift'),dir=path.join(root,'.cache'),binary=path.join(dir,'pantry-ocr');
  await mkdir(dir,{recursive:true});
  const built=await stat(binary).catch(()=>null);
  if(!built||built.mtimeMs<(await stat(source)).mtimeMs)await exec('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',path.join(tmpdir(),'pantry-lens-swift-cache'),source,'-o',binary],{timeout:120000,maxBuffer:2*1024*1024});
  return binary;
 })();
 try{return await compiling;}catch(e){compiling=null;throw e;}
}
export async function recognizeImage(bytes,mime){
 const extension=detectImage(bytes,mime),binary=await ensureOCR();
 const dir=await mkdtemp(path.join(tmpdir(),'pantry-lens-ocr-'));
 try{
  // Never use a client filename or user path. No shell interpolation.
  const file=path.join(dir,'input.'+extension);await writeFile(file,bytes,{flag:'wx',mode:0o600});
  const {stdout}=await exec(binary,[file],{timeout:30000,maxBuffer:2*1024*1024});
  const result=JSON.parse(stdout);if(!Array.isArray(result.lines))throw Error('OCR 返回格式无效');return result;
 }finally{await rm(dir,{recursive:true,force:true});}
}
