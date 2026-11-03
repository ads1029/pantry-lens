import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {ensureOCR,recognizeImage,OCRInputError,MAX_IMAGE_BYTES} from './local-ocr.mjs';
import {createRecipeQueue,RecipeError,MAX_RECIPE_BYTES} from './recipe-queue.mjs';
import {createRecipeAutomation,generateRecipes} from './recipe-generator.mjs';
import {createRecipeModelWorker} from './recipe-model-worker.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'};
const staticFiles=new Set(['/index.html','/style.css','/src/app.js','/src/core.js','/src/storage.js','/src/providers.js','/src/fingerprint.js','/src/ocr-parser.js','/src/recipes.js','/src/recipe-app.js','/src/ingredient-presets.js']);
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function readRecipeJSON(req){
 if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw new RecipeError('请发送 JSON 请求。',415);
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>MAX_RECIPE_BYTES)throw new RecipeError('请求超过 64 KiB。',413);chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RecipeError('JSON 格式错误。');}
}
export function isLocalRequest(req){
 try{const host=new URL('http://'+req.headers.host);if(!['localhost','127.0.0.1','[::1]'].includes(host.hostname))return false;const origin=req.headers.origin;return (!origin||new URL(origin).origin===host.origin)&&req.headers['x-pantry-local']==='1';}catch{return false;}
}
async function readImage(req){
 const length=Number(req.headers['content-length']);
 if(Number.isFinite(length)&&length>MAX_IMAGE_BYTES){req.resume();throw new OCRInputError('图片超过 15 MB',413);}
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>MAX_IMAGE_BYTES)throw new OCRInputError('图片超过 15 MB',413);chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export function createPantryServer({ocr=recognizeImage,recipes=createRecipeQueue(),automation=null}={}){
 let active=0;
 const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/api/recipes')){
   if(!isLocalRequest(req)){req.resume();json(res,403,{error:'仅允许本机同源食谱请求'});return;}
   try{
    if(req.url==='/api/recipes/requests'){
     if(req.method!=='POST'){req.resume();json(res,405,{error:'仅支持 POST'});return;}
     const input=await readRecipeJSON(req);
     if(automation){json(res,202,await automation.submit(input));return;}
     const request=await recipes.create(input);json(res,201,{status:'pending',request});return;
    }
    const match=req.url.match(/^\/api\/recipes\/requests\/([0-9a-f-]+)(\/(?:retry|displayed))?$/);
    if(!match)throw new RecipeError('接口不存在。',404);
    if(match[2]){
     if(req.method!=='POST'){json(res,405,{error:'仅支持 POST'});return;}
     if(match[2]==='/displayed'){json(res,200,{metrics:await recipes.displayed(match[1],await readRecipeJSON(req))});return;}
     req.resume();
     if(!automation)throw new RecipeError('自动生成器未启用。',503);
     json(res,202,await automation.retry(match[1]));return;
    }
    if(req.method!=='GET'){req.resume();json(res,405,{error:'仅支持 GET'});return;}
    json(res,200,await (automation?automation.get(match[1]):recipes.get(match[1])));
   }catch(error){json(res,error instanceof RecipeError?error.status:500,{error:error instanceof RecipeError?error.message:'本机食谱文件暂时无法读写，请检查后重试。'});}
   return;
  }
  if(req.url==='/api/ocr'){
   if(req.method!=='POST'){json(res,405,{error:'仅支持 POST'});return;}
   if(!isLocalRequest(req)){req.resume();json(res,403,{error:'仅允许本机同源照片请求'});return;}
   if(active>=2){req.resume();json(res,429,{error:'本地 OCR 忙，请稍后重试'});return;}
   active++;
   try{const bytes=await readImage(req),result=await ocr(bytes,req.headers['content-type']);json(res,200,result);}
   catch(e){if(!res.destroyed)json(res,e instanceof OCRInputError?e.status:422,{error:e instanceof OCRInputError?e.message:'本地 OCR 未完成。图片可能无法解码、过大或本机 Vision 执行失败。',...(e instanceof OCRInputError?{}:{detail:String(e.stderr||e.message).replaceAll(root,'[project]/').slice(0,1000)})});}
   finally{active--;}
   return;
  }
  try{
   if(!['GET','HEAD'].includes(req.method))throw Error('not found');
   const route=decodeURIComponent(new URL(req.url,'http://localhost').pathname),fileRoute=route==='/'?'/index.html':route;
   if(!staticFiles.has(fileRoute))throw Error('not found');
   const data=await readFile(path.join(root,fileRoute));
   res.writeHead(200,{'Content-Type':types[path.extname(fileRoute)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});res.end(req.method==='HEAD'?undefined:data);
  }catch{res.writeHead(404);res.end('Not found');}
 });
 server.requestTimeout=45000;server.headersTimeout=10000;return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // OCR is intentionally loopback-only. No network setting or LAN listener is changed.
 try{await ensureOCR();console.log('Apple Vision local OCR ready');}catch(e){console.error('Local OCR unavailable:',String(e.stderr||e.message).slice(0,1000));}
 const port=Number(process.env.PORT)||4173;
 const worker=createRecipeModelWorker();
 let connected=false;
 try{await worker.start();connected=true;console.log('Recipe model connection ready (idle: no model calls)');}catch{console.error('Recipe model connection unavailable; using isolated CLI calls');}
 const recipes=createRecipeQueue(),automation=createRecipeAutomation({queue:recipes,generate:(request,options)=>generateRecipes(request,{...options,...(connected?{catalogGenerate:worker.generate}:{})}),onError:message=>console.error(message)});
 const server=createPantryServer({recipes,automation});
 server.listen(port,'127.0.0.1',()=>console.log(`Pantry Lens (Mac only, automatic Codex recipes) → http://127.0.0.1:${port}`));
 const stop=async()=>{await automation.close();await worker.close();server.close();server.closeIdleConnections();};
 server.once('error',async()=>{await automation.close();await worker.close();});
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
