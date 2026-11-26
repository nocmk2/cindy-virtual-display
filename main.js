const CHANNEL_NAME = 'virtual-display';
const bc = new BroadcastChannel(CHANNEL_NAME);
const seenPanelReqs = new Map();

const VALID_METHODS = new Set([
  'list_displays',
  'create_virtual_display',
  'update_virtual_display',
  'destroy_virtual_display',
  'get_presets'
]);

function pruneSeen() {
  const now = Date.now();
  for (const [key, ts] of seenPanelReqs) {
    if (now - ts > 60000) seenPanelReqs.delete(key);
  }
}

async function invokeNode(method, params) {
  const response = await cindy.node.request({
    method,
    params: params && typeof params === 'object' ? params : {}
  });
  if (!response || !response.ok) {
    const message = (response && response.message) || 'Node 工作进程调用失败';
    return { ok: false, errorCode: 'NODE_REQUEST_FAILED', message };
  }
  return { ok: true, result: response.result };
}

cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  const tool = msg.tool;
  if (!VALID_METHODS.has(tool)) {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: '不支持的工具：' + String(tool || '')
    });
    return;
  }

  const outcome = await invokeNode(tool, msg.args || {});
  if (!outcome.ok) {
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: outcome.errorCode,
      message: outcome.message
    });
    return;
  }

  if (tool !== 'list_displays' && tool !== 'get_presets') {
    bc.postMessage({ type: 'state-updated', payload: outcome.result });
  }

  await cindy.send({
    type: 'tool-result',
    callId: msg.callId,
    ok: true,
    result: outcome.result
  });
});

bc.addEventListener('message', async function (event) {
  const data = event.data;
  if (!data || data.type !== 'panel-request') return;
  const { reqId, method, params } = data;
  if (!reqId || !VALID_METHODS.has(method)) return;

  pruneSeen();
  if (seenPanelReqs.has(reqId)) {
    bc.postMessage({ type: 'panel-ack', reqId });
    return;
  }
  seenPanelReqs.set(reqId, Date.now());
  bc.postMessage({ type: 'panel-ack', reqId });

  const outcome = await invokeNode(method, params || {});
  bc.postMessage({
    type: 'panel-response',
    reqId,
    ok: outcome.ok,
    result: outcome.ok ? outcome.result : undefined,
    message: outcome.ok ? undefined : outcome.message
  });
});
