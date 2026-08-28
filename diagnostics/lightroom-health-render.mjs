import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const clientId = process.env.ADOBE_CLIENT_ID || '';
const HEALTH_URL = 'https://lr.adobe.io/v2/health';
const GUARD = /^\s*while\s*\(\s*1\s*\)\s*\{\s*\}\s*/;

function emit(event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
  console.log(JSON.stringify({ event, ...safe }));
}

function parseGuardedJson(text) {
  const normalized = text.replace(GUARD, '').trim();
  return normalized ? JSON.parse(normalized) : {};
}

async function runOnce() {
  if (!clientId) {
    emit('WAVE8_LIGHTROOM_HEALTH_BLOCKED_MISSING_CLIENT_ID');
    return;
  }
  try {
    const res = await fetch(HEALTH_URL, { headers: { 'X-API-Key': clientId } });
    const text = await res.text();
    let payload = {};
    try { payload = parseGuardedJson(text); } catch { payload = {}; }
    if (!res.ok) {
      const code = payload?.error_code ?? payload?.code;
      emit('WAVE8_LIGHTROOM_HEALTH_REJECTED', {
        httpStatus: res.status,
        errorCode: typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 64) : undefined,
      });
      return;
    }
    emit('WAVE8_LIGHTROOM_HEALTH_VERIFIED', {
      httpStatus: res.status,
      serviceVersionPresent: typeof payload?.version === 'string' && payload.version.length > 0,
      userDataAccessed: false,
      oauthPerformed: false,
      mutationPerformed: false,
    });
  } catch {
    emit('WAVE8_LIGHTROOM_HEALTH_NETWORK_ERROR');
  }
}

http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'wave8-lightroom-health-diagnostic', credentialValuesExposed: false }));
}).listen(port, '0.0.0.0', () => {
  emit('WAVE8_RENDER_DIAGNOSTIC_READY', { port });
  void runOnce();
});
