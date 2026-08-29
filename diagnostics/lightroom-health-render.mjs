import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const clientId = process.env.ADOBE_CLIENT_ID || '';
const clientSecret = process.env.ADOBE_CLIENT_SECRET || '';
const TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const CONSOLE = 'https://developers.adobe.io/console';
const FIREFLY_SCOPE = 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis';
const MGMT_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext,additional_info.roles,adobeio_api,read_client_secret,manage_client_secrets';

function emit(event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
  console.log(JSON.stringify({ event, ...safe }));
}

function safeError(payload) {
  const value = payload?.error ?? payload?.error_code ?? payload?.code ?? payload?.message;
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 100) : 'provider_rejected';
}

async function token(scope) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope });
  try {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const text = await res.text();
    let payload = {};
    try { payload = JSON.parse(text); } catch {}
    const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
    return { ok: res.ok && accessToken.length > 0, httpStatus: res.status, accessToken, tokenType: payload?.token_type, expiresIn: payload?.expires_in, error: safeError(payload) };
  } catch {
    return { ok: false, httpStatus: 0, accessToken: '', error: 'network_error' };
  }
}

async function consoleGet(path, accessToken) {
  try {
    const res = await fetch(`${CONSOLE}${path}`, { headers: { Authorization: `Bearer ${accessToken}`, 'x-api-key': clientId, Accept: 'application/json' } });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { ok: res.ok, httpStatus: res.status, payload, error: payload ? safeError(payload) : 'non_json_response' };
  } catch {
    return { ok: false, httpStatus: 0, payload: null, error: 'network_error' };
  }
}

function arrayFrom(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['organizations', 'projects', 'items', 'data']) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function slimOrg(item) {
  if (!item || typeof item !== 'object') return null;
  return { id: item.id ?? item.orgId ?? item.organizationId, imsOrgId: item.ims_org_id ?? item.imsOrgId ?? item.imsOrgCode };
}

function slimProject(item) {
  if (!item || typeof item !== 'object') return null;
  return { id: item.id ?? item.projectId, title: typeof item.title === 'string' ? item.title.slice(0, 80) : undefined, name: typeof item.name === 'string' ? item.name.slice(0, 80) : undefined };
}

async function runOnce() {
  if (!clientId || !clientSecret) {
    emit('WAVE8_ADOBE_CREDENTIAL_IDENTITY_BLOCKED_MISSING_VALUE', { clientIdPresent: !!clientId, clientSecretPresent: !!clientSecret });
    return;
  }

  const firefly = await token(FIREFLY_SCOPE);
  if (!firefly.ok) {
    emit('WAVE8_ADOBE_CANDIDATE_SECRET_REJECTED', { httpStatus: firefly.httpStatus, error: firefly.error });
    return;
  }
  emit('WAVE8_ADOBE_CANDIDATE_SECRET_CONFIRMED', { httpStatus: firefly.httpStatus, tokenType: firefly.tokenType, expiresIn: firefly.expiresIn, accessTokenExposed: false });

  const orgs = await consoleGet('/organizations', firefly.accessToken);
  if (orgs.ok) {
    const slim = arrayFrom(orgs.payload).map(slimOrg).filter(Boolean).slice(0, 10);
    emit('WAVE8_ADOBE_CONSOLE_ORGS_READ_OK', { httpStatus: orgs.httpStatus, count: slim.length, organizations: slim });
    for (const org of slim) {
      if (!org.id) continue;
      const projects = await consoleGet(`/organizations/${encodeURIComponent(String(org.id))}/projects`, firefly.accessToken);
      if (projects.ok) {
        const p = arrayFrom(projects.payload).map(slimProject).filter(Boolean).slice(0, 20);
        emit('WAVE8_ADOBE_CONSOLE_PROJECTS_READ_OK', { orgId: String(org.id), httpStatus: projects.httpStatus, count: p.length, projects: p });
      } else {
        emit('WAVE8_ADOBE_CONSOLE_PROJECTS_READ_REJECTED', { orgId: String(org.id), httpStatus: projects.httpStatus, error: projects.error });
      }
      const services = await consoleGet(`/organizations/${encodeURIComponent(String(org.id))}/services`, firefly.accessToken);
      if (services.ok) {
        const serviceItems = arrayFrom(services.payload).slice(0, 200).map((s) => ({ sdkCode: s?.sdkCode ?? s?.code, name: typeof s?.name === 'string' ? s.name.slice(0, 100) : undefined })).filter((s) => s.sdkCode || s.name);
        const lightroom = serviceItems.filter((s) => /lightroom/i.test(`${s.sdkCode ?? ''} ${s.name ?? ''}`));
        emit('WAVE8_ADOBE_CONSOLE_SERVICES_READ_OK', { orgId: String(org.id), httpStatus: services.httpStatus, lightroomCandidates: lightroom.slice(0, 20) });
      } else {
        emit('WAVE8_ADOBE_CONSOLE_SERVICES_READ_REJECTED', { orgId: String(org.id), httpStatus: services.httpStatus, error: services.error });
      }
    }
  } else {
    emit('WAVE8_ADOBE_CONSOLE_ORGS_READ_REJECTED', { httpStatus: orgs.httpStatus, error: orgs.error });
  }

  const mgmt = await token(MGMT_SCOPE);
  if (mgmt.ok) emit('WAVE8_ADOBE_IO_MANAGEMENT_TOKEN_VERIFIED', { httpStatus: mgmt.httpStatus, tokenType: mgmt.tokenType, expiresIn: mgmt.expiresIn, accessTokenExposed: false });
  else emit('WAVE8_ADOBE_IO_MANAGEMENT_TOKEN_REJECTED', { httpStatus: mgmt.httpStatus, error: mgmt.error });
}

http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'wave8-adobe-console-diagnostic', credentialValuesExposed: false }));
}).listen(port, '0.0.0.0', () => {
  emit('WAVE8_RENDER_DIAGNOSTIC_READY', { port });
  void runOnce();
});
