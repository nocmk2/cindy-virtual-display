const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const HELPER_PATH = path.resolve(__dirname, '..', 'bin', 'virtual-display-helper');

const PRESETS = [
  { id: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080, refreshRate: 60, hiDPI: true },
  { id: '1440p', label: '2K (QHD)', width: 2560, height: 1440, refreshRate: 60, hiDPI: true },
  { id: '1440x900', label: '1440×900 (Compact)', width: 1440, height: 900, refreshRate: 60, hiDPI: true },
  { id: '1280x720', label: '720p (HD)', width: 1280, height: 720, refreshRate: 60, hiDPI: false },
  { id: '4k', label: '4K (UHD)', width: 3840, height: 2160, refreshRate: 60, hiDPI: false }
];

const PRESET_MAP = new Map(PRESETS.map((p) => [p.id, p]));

// Each virtual display runs in its own tiny native helper process so destroying it
// terminates the process and guarantees macOS WindowServer immediately releases the display.
const holders = new Map();
let handleSeq = 0;
let serialSeq = 0;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureSupported() {
  if (process.platform !== 'darwin') {
    throw new Error('Virtual Display 仅支持 macOS（当前系统：' + process.platform + '）。');
  }
  if (!fs.existsSync(HELPER_PATH)) {
    throw new Error('找不到本机助手程序：' + HELPER_PATH);
  }
}

function querySystemDisplays() {
  ensureSupported();
  return new Promise((resolve, reject) => {
    execFile(HELPER_PATH, ['--list'], { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(new Error('查询系统显示器失败：' + err.message));
        return;
      }
      const line = String(stdout || '').trim().split('\n').pop();
      try {
        const parsed = JSON.parse(line);
        resolve(parsed);
      } catch {
        reject(new Error('解析系统显示器输出失败。'));
      }
    });
  });
}

function buildManagedList() {
  return [...holders.values()]
    .sort((a, b) => a.handleId.localeCompare(b.handleId))
    .map((h) => ({ ...h.meta }));
}

async function buildSnapshot() {
  const sys = await querySystemDisplays();
  const byDisplayId = new Map();
  for (const h of holders.values()) {
    if (h.meta && h.meta.displayID) {
      byDisplayId.set(h.meta.displayID, h);
    }
  }
  const displays = (sys.displays || []).map((d) => {
    const h = byDisplayId.get(d.displayID);
    if (h) {
      return {
        ...d,
        name: h.meta.name || d.name,
        isManagedVirtual: true,
        handleId: h.handleId
      };
    }
    return d;
  });
  return {
    platform: process.platform,
    apiAvailable: Boolean(sys.apiAvailable),
    presets: PRESETS,
    managed: buildManagedList(),
    displays
  };
}

function spawnHolder(handleId) {
  ensureSupported();
  const proc = spawn(HELPER_PATH, ['--daemon'], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const pending = new Map();
  let seq = 0;

  const holder = {
    handleId,
    proc,
    innerHandleId: null,
    maxPixelsWide: 5120,
    maxPixelsHigh: 2880,
    meta: null,
    sendCmd(cmdObj, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        if (proc.exitCode !== null || proc.killed) {
          reject(new Error('虚拟屏进程已退出。'));
          return;
        }
        seq += 1;
        const id = seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('虚拟屏助手响应超时。'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          proc.stdin.write(JSON.stringify({ ...cmdObj, id }) + '\n');
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        }
      });
    },
    terminate() {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(forceTimer);
          resolve();
        };
        proc.once('exit', finish);
        const forceTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
          finish();
        }, 1500);
        try {
          proc.stdin.end();
        } catch {
          // ignore
        }
        try {
          proc.kill('SIGTERM');
        } catch {
          finish();
        }
      });
    }
  };

  const failPending = (reason) => {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(new Error(reason));
    }
    pending.clear();
  };

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.event) return;
    const id = msg.id;
    if (id != null && pending.has(id)) {
      const item = pending.get(id);
      pending.delete(id);
      clearTimeout(item.timer);
      if (msg.ok) {
        item.resolve(msg);
      } else {
        item.reject(new Error(msg.error || '虚拟屏助手返回错误。'));
      }
    }
  });

  proc.on('error', (err) => {
    if (holders.get(handleId) === holder) holders.delete(handleId);
    failPending('启动虚拟屏助手失败：' + err.message);
  });

  proc.on('exit', () => {
    if (holders.get(handleId) === holder) holders.delete(handleId);
    failPending('虚拟屏助手进程已退出。');
  });

  return holder;
}

function stopAllHoldersSync() {
  for (const holder of holders.values()) {
    try {
      holder.proc.stdin.end();
    } catch {
      // ignore
    }
    try {
      holder.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  holders.clear();
}

function parsePositiveInt(val, field, min, max) {
  const num = Number(val);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new Error(`${field} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return num;
}

function resolveDisplayParams(params, defaults) {
  const input = params && typeof params === 'object' ? params : {};
  const preset = typeof input.preset === 'string' && input.preset.trim()
    ? PRESET_MAP.get(input.preset.trim().toLowerCase())
    : null;
  if (typeof input.preset === 'string' && input.preset.trim() && !preset) {
    throw new Error(`不支持的预设 "${input.preset}"，可选值：${PRESETS.map((p) => p.id).join(', ')}。`);
  }

  const base = preset || defaults || PRESETS[0];
  const width = input.width !== undefined && input.width !== null && input.width !== ''
    ? parsePositiveInt(input.width, 'width', 640, 7680)
    : base.width;
  const height = input.height !== undefined && input.height !== null && input.height !== ''
    ? parsePositiveInt(input.height, 'height', 480, 4320)
    : base.height;
  const refreshRate = input.refreshRate !== undefined && input.refreshRate !== null && input.refreshRate !== ''
    ? parsePositiveInt(input.refreshRate, 'refreshRate', 24, 240)
    : base.refreshRate;
  const hiDPI = typeof input.hiDPI === 'boolean' ? input.hiDPI : base.hiDPI;
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim().slice(0, 64)
    : (defaults && defaults.name) || 'Cindy Virtual Display';

  return { name, width, height, refreshRate, hiDPI };
}

async function createWithHandle(handleId, cfg) {
  serialSeq += 1;
  const serialNum = (0xC1D00000 + ((process.pid & 0xFF) << 8) + (serialSeq & 0xFF)) >>> 0;
  const holder = spawnHolder(handleId);
  try {
    const res = await holder.sendCmd({
      cmd: 'create',
      name: cfg.name,
      width: cfg.width,
      height: cfg.height,
      refreshRate: cfg.refreshRate,
      hiDPI: cfg.hiDPI,
      serialNum
    });
    const d = res.display;
    holder.innerHandleId = d.handleId;
    holder.maxPixelsWide = Math.max(cfg.hiDPI ? Math.min(cfg.width * 2, 7680) : cfg.width, 5120);
    holder.maxPixelsHigh = Math.max(cfg.hiDPI ? Math.min(cfg.height * 2, 4320) : cfg.height, 2880);
    holder.meta = {
      handleId,
      displayID: d.displayID,
      name: d.name,
      width: d.width,
      height: d.height,
      refreshRate: d.refreshRate,
      hiDPI: d.hiDPI,
      createdAt: d.createdAt
    };
    holders.set(handleId, holder);
    return holder.meta;
  } catch (err) {
    await holder.terminate();
    throw err;
  }
}

async function handleMethod(method, params) {
  if (method === 'get_presets') {
    return {
      platform: process.platform,
      supported: process.platform === 'darwin',
      presets: PRESETS
    };
  }

  if (method === 'list_displays') {
    return await buildSnapshot();
  }

  if (method === 'create_virtual_display') {
    const cfg = resolveDisplayParams(params, PRESETS[0]);
    handleSeq += 1;
    const handleId = 'vd-' + handleSeq;
    const display = await createWithHandle(handleId, cfg);
    const snapshot = await buildSnapshot();
    return { display, ...snapshot };
  }

  if (method === 'update_virtual_display') {
    const handleId = typeof params?.handleId === 'string' ? params.handleId.trim() : '';
    if (!handleId) {
      throw new Error('handleId 不能为空，请先调用 list_displays 查看托管虚拟屏的 handleId。');
    }
    const existing = holders.get(handleId);
    if (!existing) {
      throw new Error(`找不到 handleId 为 "${handleId}" 的托管虚拟屏。`);
    }
    const cfg = resolveDisplayParams(params, existing.meta);
    const reqW = cfg.hiDPI ? Math.min(cfg.width * 2, 7680) : cfg.width;
    const reqH = cfg.hiDPI ? Math.min(cfg.height * 2, 4320) : cfg.height;

    let display;
    if (cfg.name === existing.meta.name && reqW <= existing.maxPixelsWide && reqH <= existing.maxPixelsHigh) {
      const res = await existing.sendCmd({
        cmd: 'update',
        handleId: existing.innerHandleId,
        name: cfg.name,
        width: cfg.width,
        height: cfg.height,
        refreshRate: cfg.refreshRate,
        hiDPI: cfg.hiDPI
      });
      const d = res.display;
      existing.meta = {
        handleId,
        displayID: d.displayID,
        name: d.name,
        width: d.width,
        height: d.height,
        refreshRate: d.refreshRate,
        hiDPI: d.hiDPI,
        createdAt: existing.meta.createdAt
      };
      display = existing.meta;
    } else {
      holders.delete(handleId);
      await existing.terminate();
      await sleep(200);
      display = await createWithHandle(handleId, cfg);
    }
    const snapshot = await buildSnapshot();
    return { display, ...snapshot };
  }

  if (method === 'destroy_virtual_display') {
    const all = params?.all === true;
    const handleId = typeof params?.handleId === 'string' ? params.handleId.trim() : '';
    if (!all && !handleId) {
      throw new Error('请提供要关闭的 handleId，或传 all: true 关闭全部由本插件创建的虚拟屏。');
    }

    const targets = [];
    if (all) {
      for (const h of holders.values()) targets.push(h);
      holders.clear();
    } else {
      const h = holders.get(handleId);
      if (!h) {
        throw new Error(`找不到 handleId 为 "${handleId}" 的托管虚拟屏。`);
      }
      holders.delete(handleId);
      targets.push(h);
    }

    await Promise.all(targets.map((h) => h.terminate()));
    if (targets.length > 0) {
      await sleep(250);
    }
    const snapshot = await buildSnapshot();
    return { removed: targets.length, ...snapshot };
  }

  const err = new Error('Method not found: ' + method);
  err.code = -32601;
  throw err;
}

const inputRl = readline.createInterface({ input: process.stdin });
let inFlight = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && inFlight === 0) {
    stopAllHoldersSync();
    process.exit(0);
  }
}

inputRl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  inFlight += 1;
  handleMethod(request.method, request.params)
    .then((result) => {
      reply({ jsonrpc: '2.0', id: request.id, result });
    })
    .catch((err) => {
      reply({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: typeof err.code === 'number' ? err.code : -32000,
          message: err.message || String(err)
        }
      });
    })
    .finally(() => {
      inFlight -= 1;
      maybeExit();
    });
});

inputRl.on('close', () => {
  stdinClosed = true;
  maybeExit();
});

process.on('SIGTERM', () => {
  stopAllHoldersSync();
  process.exit(0);
});

process.on('SIGINT', () => {
  stopAllHoldersSync();
  process.exit(0);
});

process.on('exit', () => {
  stopAllHoldersSync();
});
