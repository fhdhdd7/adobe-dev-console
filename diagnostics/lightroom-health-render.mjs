import http from 'node:http';

const port = Number(process.env.PORT || 10000);
const clientId = process.env.ADOBE_CLIENT_ID || '';
const entryToken = process.env.WAVE8_ENTRY_TOKEN || '';
const TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const CONSOLE = 'https://developers.adobe.io/console';
const FIREFLY_SCOPE = 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis';
const MGMT_SCOPE = 'AdobeID,openid,read_organizations,additional_info.projectedProductContext,additional_info.roles,adobeio_api,read_client_secret,manage_client_secrets';
let consumed = false;

function emit(event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
  console.log(JSON.stringify({ event, ...safe }));
}

function safeError(payload) {
  const value = payload?.error ?? payload?.error_code ?? payload?.code ?? payload?.message;
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 100) : 'provider_rejected';
}

async function token(clientSecret, scope) {
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
  for (const key of ['organizations', 'projects', 'workspaces', 'services', 'items', 'data']) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function slimOrg(item) {
  if (!item || typeof item !== 'object') return null;
  return { id: item.id ?? item.orgId ?? item.organizationId, imsOrgId: item.ims_org_id ?? item.imsOrgId ?? item.imsOrgCode, name: typeof item.name === 'string' ? item.name.slice(0, 80) : undefined };
}

function slimProject(item) {
  if (!item || typeof item !== 'object') return null;
  return { id: item.id ?? item.projectId, title: typeof item.title === 'string' ? item.title.slice(0, 80) : undefined, name: typeof item.name === 'string' ? item.name.slice(0, 80) : undefined, type: item.type };
}

function slimWorkspace(item) {
  if (!item || typeof item !== 'object') return null;
  return { id: item.id ?? item.workspaceId, title: typeof item.title === 'string' ? item.title.slice(0, 80) : undefined, name: typeof item.name === 'string' ? item.name.slice(0, 80) : undefined };
}

function slimCredential(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    id: item.id ?? item.credentialId ?? item.integrationId,
    type: item.type ?? item.credentialType,
    clientId: item.client_id ?? item.clientId ?? item.oauth_server_to_server?.client_id ?? item.adobeid?.client_id,
    name: typeof item.name === 'string' ? item.name.slice(0, 80) : undefined,
  };
}

async function qualify(clientSecret) {
  const firefly = await token(clientSecret, FIREFLY_SCOPE);
  if (!firefly.ok) {
    emit('WAVE8_ADOBE_SECRET_REJECTED', { httpStatus: firefly.httpStatus, error: firefly.error });
    return { ok: false, stage: 'oauth', message: 'Adobe rejected this Client Secret for the known Client ID.' };
  }
  emit('WAVE8_ADOBE_SECRET_CONFIRMED', { httpStatus: firefly.httpStatus, tokenType: firefly.tokenType, expiresIn: firefly.expiresIn, accessTokenExposed: false });

  const orgs = await consoleGet('/organizations', firefly.accessToken);
  if (!orgs.ok) {
    emit('WAVE8_ADOBE_CONSOLE_ORGS_READ_REJECTED', { httpStatus: orgs.httpStatus, error: orgs.error });
  } else {
    const slimOrgs = arrayFrom(orgs.payload).map(slimOrg).filter(Boolean).slice(0, 10);
    emit('WAVE8_ADOBE_CONSOLE_ORGS_READ_OK', { httpStatus: orgs.httpStatus, count: slimOrgs.length, organizations: slimOrgs });
    for (const org of slimOrgs) {
      if (!org.id) continue;
      const orgId = String(org.id);
      const projects = await consoleGet(`/organizations/${encodeURIComponent(orgId)}/projects`, firefly.accessToken);
      const slimProjects = projects.ok ? arrayFrom(projects.payload).map(slimProject).filter(Boolean).slice(0, 30) : [];
      if (projects.ok) emit('WAVE8_ADOBE_CONSOLE_PROJECTS_READ_OK', { orgId, httpStatus: projects.httpStatus, count: slimProjects.length, projects: slimProjects });
      else emit('WAVE8_ADOBE_CONSOLE_PROJECTS_READ_REJECTED', { orgId, httpStatus: projects.httpStatus, error: projects.error });

      const services = await consoleGet(`/organizations/${encodeURIComponent(orgId)}/services`, firefly.accessToken);
      if (services.ok) {
        const serviceItems = arrayFrom(services.payload).slice(0, 300).map((s) => ({ sdkCode: s?.sdkCode ?? s?.code, name: typeof s?.name === 'string' ? s.name.slice(0, 100) : undefined, id: s?.id })).filter((s) => s.sdkCode || s.name || s.id);
        emit('WAVE8_ADOBE_CONSOLE_SERVICES_READ_OK', { orgId, httpStatus: services.httpStatus, lightroomCandidates: serviceItems.filter((s) => /lightroom/i.test(`${s.sdkCode ?? ''} ${s.name ?? ''}`)).slice(0, 30) });
      } else emit('WAVE8_ADOBE_CONSOLE_SERVICES_READ_REJECTED', { orgId, httpStatus: services.httpStatus, error: services.error });

      for (const project of slimProjects) {
        if (!project.id) continue;
        const projectId = String(project.id);
        const workspaces = await consoleGet(`/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/workspaces`, firefly.accessToken);
        if (!workspaces.ok) {
          emit('WAVE8_ADOBE_CONSOLE_WORKSPACES_READ_REJECTED', { orgId, projectId, httpStatus: workspaces.httpStatus, error: workspaces.error });
          continue;
        }
        const slimWorkspaces = arrayFrom(workspaces.payload).map(slimWorkspace).filter(Boolean).slice(0, 20);
        emit('WAVE8_ADOBE_CONSOLE_WORKSPACES_READ_OK', { orgId, projectId, httpStatus: workspaces.httpStatus, count: slimWorkspaces.length, workspaces: slimWorkspaces });
        for (const workspace of slimWorkspaces) {
          if (!workspace.id) continue;
          const workspaceId = String(workspace.id);
          const detail = await consoleGet(`/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, firefly.accessToken);
          if (!detail.ok) continue;
          const candidates = [];
          const source = detail.payload ?? {};
          for (const value of [source.credentials, source.details?.credentials, source.workspace?.details?.credentials]) {
            if (Array.isArray(value)) candidates.push(...value);
          }
          const credentials = candidates.map(slimCredential).filter(Boolean).slice(0, 30);
          emit('WAVE8_ADOBE_CONSOLE_WORKSPACE_DETAIL_OK', { orgId, projectId, workspaceId, credentials });
        }
      }
    }
  }

  const mgmt = await token(clientSecret, MGMT_SCOPE);
  if (mgmt.ok) emit('WAVE8_ADOBE_IO_MANAGEMENT_TOKEN_VERIFIED', { httpStatus: mgmt.httpStatus, tokenType: mgmt.tokenType, expiresIn: mgmt.expiresIn, accessTokenExposed: false });
  else emit('WAVE8_ADOBE_IO_MANAGEMENT_TOKEN_REJECTED', { httpStatus: mgmt.httpStatus, error: mgmt.error });

  return { ok: true, stage: 'complete', message: 'Credential accepted. Adobe Console read-only inspection completed; no secret or access token was stored.' };
}

function html(body, status = 200) {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: `<!doctype html><html lang="ar" dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wave 8 Adobe</title><body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:20px"><h2>Wave 8 — Adobe</h2>${body}</body></html>` };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const tokenOk = entryToken && url.searchParams.get('t') === entryToken;

  if (req.method === 'GET' && url.pathname === '/') {
    if (!tokenOk || consumed) {
      const out = html('<p>الرابط غير صالح أو تم استخدامه.</p>', 404);
      res.writeHead(out.status, out.headers); res.end(out.body); return;
    }
    const out = html('<p>ألصق <b>Client Secret</b> الصحيح لاعتماد Adobe الذي يحمل Client ID المعروف. لن يُحفظ أو يُطبع.</p><form method="post" action="/qualify?t=' + encodeURIComponent(entryToken) + '"><input type="password" name="client_secret" autocomplete="off" required style="width:100%;padding:12px;box-sizing:border-box"><button type="submit" style="margin-top:12px;padding:12px 20px">تحقق بأمان</button></form>');
    res.writeHead(out.status, out.headers); res.end(out.body); return;
  }

  if (req.method === 'POST' && url.pathname === '/qualify') {
    if (!tokenOk || consumed) {
      const out = html('<p>الرابط غير صالح أو تم استخدامه.</p>', 404);
      res.writeHead(out.status, out.headers); res.end(out.body); return;
    }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) break;
    }
    const form = new URLSearchParams(raw);
    const clientSecret = form.get('client_secret') || '';
    if (!clientSecret || clientSecret.length > 512) {
      const out = html('<p>لم يتم إدخال قيمة صالحة.</p>', 400);
      res.writeHead(out.status, out.headers); res.end(out.body); return;
    }
    consumed = true;
    const result = await qualify(clientSecret);
    const out = html(`<p>${result.ok ? 'تم التحقق والتنقيب بنجاح.' : 'رفض Adobe هذه القيمة.'}</p><p>يمكنك العودة إلى ChatGPT الآن. لا ترسل السر في المحادثة.</p>`, result.ok ? 200 : 400);
    res.writeHead(out.status, out.headers); res.end(out.body); return;
  }

  res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(port, '0.0.0.0', () => emit('WAVE8_RENDER_SECURE_ENTRY_READY', { port, clientIdPresent: !!clientId, entryTokenPresent: !!entryToken }));
