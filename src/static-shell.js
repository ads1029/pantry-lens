document.querySelector('#about').onclick = event => {
  event.preventDefault();
  const status = document.querySelector('#status');
  status.textContent = '5000份中西式温和搭配，浏览器内匹配，不调用AI、不上传食材。支持1–4人及简单偏好筛选，最近一次推荐保存在当前浏览器。用量仅供参考，请核对忌口和配料。';
  status.hidden = false;
  clearTimeout(status.timer);
  status.timer = setTimeout(() => { status.hidden = true; }, 12000);
};
