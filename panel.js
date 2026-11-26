const CHANNEL_NAME = 'virtual-display';
const bc = new BroadcastChannel(CHANNEL_NAME);
const pending = new Map();

let currentState = {
  presets: [
    { id: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080, refreshRate: 60, hiDPI: true },
    { id: '1440p', label: '2K (QHD)', width: 2560, height: 1440, refreshRate: 60, hiDPI: true },
    { id: '1440x900', label: '1440×900 (Compact)', width: 1440, height: 900, refreshRate: 60, hiDPI: true },
    { id: '1280x720', label: '720p (HD)', width: 1280, height: 720, refreshRate: 60, hiDPI: false },
    { id: '4k', label: '4K (UHD)', width: 3840, height: 2160, refreshRate: 60, hiDPI: false }
  ],
  managed: [],
  displays: [],
  apiAvailable: true
};
let busy = false;

const $ = (id) => document.getElementById(id);

function setBanner(type, text) {
  const errEl = $('errorBanner');
  const infoEl = $('infoBanner');
  if (type === 'error') {
    errEl.textContent = text;
    errEl.hidden = !text;
    if (text) infoEl.hidden = true;
  } else if (type === 'info') {
    infoEl.textContent = text;
    infoEl.hidden = !text;
    if (text) errEl.hidden = true;
  } else {
    errEl.hidden = true;
    infoEl.hidden = true;
  }
}

function setBusy(flag) {
  busy = flag;
  $('refreshBtn').disabled = flag;
  $('destroyAllBtn').disabled = flag;
  $('createBtn').disabled = flag;
  for (const btn of document.querySelectorAll('.preset-btn, .item-action-btn, .preset-select')) {
    btn.disabled = flag;
  }
}

bc.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'panel-ack' && msg.reqId && pending.has(msg.reqId)) {
    const item = pending.get(msg.reqId);
    if (item.retryTimer) {
      clearInterval(item.retryTimer);
      item.retryTimer = null;
    }
    return;
  }
  if (msg.type === 'panel-response' && msg.reqId && pending.has(msg.reqId)) {
    const item = pending.get(msg.reqId);
    pending.delete(msg.reqId);
    if (item.retryTimer) clearInterval(item.retryTimer);
    clearTimeout(item.timeoutTimer);
    if (msg.ok) {
      item.resolve(msg.result);
    } else {
      item.reject(new Error(msg.message || '操作失败'));
    }
    return;
  }
  if (msg.type === 'state-updated' && msg.payload) {
    applyState(msg.payload);
  }
});

async function callBrain(method, params) {
  try {
    await fetch('cindy-ghost://virtual-display/wake');
  } catch {
    // ignore wake errors; still attempt broadcast
  }

  const reqId = 'vd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve, reject) => {
    const payload = { type: 'panel-request', reqId, method, params: params || {} };
    const timeoutTimer = setTimeout(() => {
      const item = pending.get(reqId);
      if (item && item.retryTimer) clearInterval(item.retryTimer);
      pending.delete(reqId);
      reject(new Error('请求超时，请检查插件是否已启用。'));
    }, 18000);

    const retryTimer = setInterval(() => {
      bc.postMessage(payload);
    }, 350);

    pending.set(reqId, { resolve, reject, retryTimer, timeoutTimer });
    bc.postMessage(payload);
  });
}

function renderPresets() {
  const grid = $('presetGrid');
  grid.innerHTML = '';
  for (const preset of currentState.presets) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-btn';
    btn.disabled = busy;

    const title = document.createElement('span');
    title.className = 'preset-title';
    title.textContent = preset.label;

    const sub = document.createElement('span');
    sub.className = 'preset-sub';
    sub.textContent = `${preset.width}×${preset.height} · ${preset.refreshRate}Hz${preset.hiDPI ? ' · HiDPI' : ''}`;

    btn.appendChild(title);
    btn.appendChild(sub);
    btn.addEventListener('click', () => handleCreate({ preset: preset.id }));
    grid.appendChild(btn);
  }
}

function renderManaged() {
  const list = $('managedList');
  const managed = currentState.managed || [];
  $('managedCount').textContent = String(managed.length);
  $('destroyAllBtn').hidden = managed.length === 0;

  list.innerHTML = '';
  if (managed.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前没有运行中的虚拟显示器';
    list.appendChild(empty);
    return;
  }

  for (const item of managed) {
    const row = document.createElement('div');
    row.className = 'display-item';

    const info = document.createElement('div');
    info.className = 'display-info';

    const title = document.createElement('div');
    title.className = 'display-title';
    title.textContent = item.name || 'Cindy Virtual Display';

    const pill = document.createElement('span');
    pill.className = 'pill pill-virtual';
    pill.textContent = item.handleId;
    title.appendChild(pill);

    const sub = document.createElement('div');
    sub.className = 'display-sub';
    sub.textContent = `Display #${item.displayID} · ${item.width}×${item.height} @ ${item.refreshRate}Hz${item.hiDPI ? ' · HiDPI' : ''}`;

    info.appendChild(title);
    info.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'display-actions';

    const select = document.createElement('select');
    select.className = 'preset-select';
    select.disabled = busy;
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '切换分辨率…';
    select.appendChild(defaultOpt);
    for (const p of currentState.presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.width}×${p.height}${p.hiDPI ? ' HiDPI' : ''}`;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const val = select.value;
      select.value = '';
      if (val) handleUpdate(item.handleId, { preset: val });
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'btn btn-danger-ghost item-action-btn';
    stopBtn.textContent = '关闭';
    stopBtn.disabled = busy;
    stopBtn.addEventListener('click', () => handleDestroy({ handleId: item.handleId }));

    actions.appendChild(select);
    actions.appendChild(stopBtn);

    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderAllDisplays() {
  const list = $('allDisplayList');
  const displays = currentState.displays || [];
  $('allCount').textContent = String(displays.length);

  list.innerHTML = '';
  if (displays.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前未检测到在线显示器';
    list.appendChild(empty);
    return;
  }

  for (const d of displays) {
    const row = document.createElement('div');
    row.className = 'display-item';

    const info = document.createElement('div');
    info.className = 'display-info';

    const title = document.createElement('div');
    title.className = 'display-title';
    title.textContent = d.name || `Display ${d.displayID}`;

    if (d.isMain) {
      const mainPill = document.createElement('span');
      mainPill.className = 'pill pill-main';
      mainPill.textContent = '主屏';
      title.appendChild(mainPill);
    }
    if (d.isManagedVirtual) {
      const vPill = document.createElement('span');
      vPill.className = 'pill pill-virtual';
      vPill.textContent = '虚拟屏';
      title.appendChild(vPill);
    } else if (d.isBuiltin) {
      const bPill = document.createElement('span');
      bPill.className = 'pill';
      bPill.textContent = '内建';
      title.appendChild(bPill);
    }

    const sub = document.createElement('div');
    sub.className = 'display-sub';
    const pxText = d.hiDPI ? `（物理 ${d.pixelWidth}×${d.pixelHeight} HiDPI）` : '';
    sub.textContent = `ID ${d.displayID} · ${d.width}×${d.height}${pxText} · ${Math.round(d.refreshRate || 60)}Hz · 位置 (${d.originX}, ${d.originY})`;

    info.appendChild(title);
    info.appendChild(sub);
    row.appendChild(info);
    list.appendChild(row);
  }
}

function renderStatus() {
  const dot = $('statusDot');
  const text = $('statusText');
  dot.className = 'status-dot';
  if (!currentState.apiAvailable) {
    dot.classList.add('err');
    text.textContent = '当前系统不支持 CGVirtualDisplay';
    return;
  }
  const managedCount = (currentState.managed || []).length;
  const totalCount = (currentState.displays || []).length;
  if (managedCount > 0) {
    dot.classList.add('ok');
    text.textContent = `虚拟屏运行中（${managedCount} 块虚拟 / 共 ${totalCount} 块在线）`;
  } else {
    dot.classList.add('warn');
    text.textContent = `已就绪（当前 ${totalCount} 块在线显示器）`;
  }
}

function applyState(data) {
  if (Array.isArray(data.presets) && data.presets.length > 0) {
    currentState.presets = data.presets;
  }
  if (Array.isArray(data.managed)) {
    currentState.managed = data.managed;
  }
  if (Array.isArray(data.displays)) {
    currentState.displays = data.displays;
  }
  if (typeof data.apiAvailable === 'boolean') {
    currentState.apiAvailable = data.apiAvailable;
  }
  renderStatus();
  renderPresets();
  renderManaged();
  renderAllDisplays();
}

async function refresh() {
  setBusy(true);
  setBanner('', '');
  try {
    const res = await callBrain('list_displays');
    applyState(res);
  } catch (err) {
    $('statusDot').className = 'status-dot err';
    $('statusText').textContent = '无法连接本机助手';
    setBanner('error', err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function handleCreate(params) {
  setBusy(true);
  setBanner('', '');
  try {
    const res = await callBrain('create_virtual_display', params);
    applyState(res);
    const d = res.display;
    if (d) {
      setBanner('info', `已创建虚拟屏「${d.name}」（${d.width}×${d.height} @ ${d.refreshRate}Hz${d.hiDPI ? ' HiDPI' : ''}，Display #${d.displayID}）`);
    }
  } catch (err) {
    setBanner('error', err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function handleUpdate(handleId, params) {
  setBusy(true);
  setBanner('', '');
  try {
    const res = await callBrain('update_virtual_display', { handleId, ...params });
    applyState(res);
    const d = res.display;
    if (d) {
      setBanner('info', `已更新 ${handleId} 为 ${d.width}×${d.height} @ ${d.refreshRate}Hz${d.hiDPI ? ' HiDPI' : ''}`);
    }
  } catch (err) {
    setBanner('error', err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function handleDestroy(params) {
  setBusy(true);
  setBanner('', '');
  try {
    const res = await callBrain('destroy_virtual_display', params);
    applyState(res);
    setBanner('info', `已关闭 ${res.removed || 0} 块虚拟显示器`);
  } catch (err) {
    setBanner('error', err.message || String(err));
  } finally {
    setBusy(false);
  }
}

async function loadSavedPrefs() {
  try {
    const res = await fetch('/kv');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg && typeof cfg === 'object') {
      if (typeof cfg.name === 'string' && cfg.name.trim()) $('nameInput').value = cfg.name;
      if (Number.isInteger(cfg.width)) $('widthInput').value = String(cfg.width);
      if (Number.isInteger(cfg.height)) $('heightInput').value = String(cfg.height);
      if (Number.isInteger(cfg.refreshRate)) $('refreshInput').value = String(cfg.refreshRate);
      if (typeof cfg.hiDPI === 'boolean') $('hidpiInput').checked = cfg.hiDPI;
    }
  } catch {
    // ignore
  }
}

async function savePrefs(cfg) {
  try {
    await fetch('/kv', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg)
    });
  } catch {
    // ignore
  }
}

$('refreshBtn').addEventListener('click', refresh);
$('destroyAllBtn').addEventListener('click', () => handleDestroy({ all: true }));

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cfg = {
    name: $('nameInput').value.trim() || 'Cindy Virtual Display',
    width: Number($('widthInput').value),
    height: Number($('heightInput').value),
    refreshRate: Number($('refreshInput').value),
    hiDPI: $('hidpiInput').checked
  };
  await savePrefs(cfg);
  await handleCreate(cfg);
});

renderPresets();
loadSavedPrefs().finally(refresh);
