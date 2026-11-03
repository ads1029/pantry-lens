document.querySelector('#about').onclick = event => {
  event.preventDefault();
  const status = document.querySelector('#status');
  status.textContent = '在线版：24道内置家常菜，按已有主料、时间、人数、简单口味和忌口在浏览器内匹配，不调用AI。最近一次推荐仅保存在当前浏览器；不上传食材。匹配不足三道会提示调整条件，不编造结果。在线版不提供照片OCR或库存功能。';
  status.hidden = false;
  clearTimeout(status.timer);
  status.timer = setTimeout(() => { status.hidden = true; }, 12000);
};
