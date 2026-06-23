const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const fs = require('fs');

// ══════════════════════════════════════════════════════════════
// GOOGLE CALENDAR SYNC (Service Account, sem dependência externa)
// Variáveis de ambiente necessárias:
//   GOOGLE_SERVICE_ACCOUNT_JSON  → conteúdo do arquivo JSON da conta de serviço
//   GOOGLE_CALENDAR_ID           → ex: abc123@group.calendar.google.com
// ══════════════════════════════════════════════════════════════
let _gcalSA = null;      // parsed service account JSON
let _gcalId = null;      // calendar ID
let _gcalToken = null;   // { token, expiresAt }

function setupGoogleCalendar() {
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const calId = process.env.GOOGLE_CALENDAR_ID;
  if (!saRaw || !calId) return;
  try {
    _gcalSA = JSON.parse(saRaw);
    _gcalId = calId;
    console.log('[GCal] Google Calendar configurado:', calId);
  } catch (e) {
    console.error('[GCal] Erro ao parsear GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
  }
}

async function gcalGetToken() {
  if (!_gcalSA) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_gcalToken && _gcalToken.expiresAt > now + 60) return _gcalToken.token;

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: _gcalSA.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const toSign = `${header}.${payload}`;
  const sig = crypto.createSign('RSA-SHA256').update(toSign).sign(_gcalSA.private_key, 'base64url');
  const jwt = `${toSign}.${sig}`;

  return new Promise((resolve) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.access_token) {
            _gcalToken = { token: j.access_token, expiresAt: now + (j.expires_in || 3600) };
            resolve(j.access_token);
          } else { console.error('[GCal] Token error:', data); resolve(null); }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('[GCal] Token request error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function gcalHttpRequest(method, urlPath, token, bodyObj) {
  return new Promise((resolve) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const opts = {
      hostname: 'www.googleapis.com',
      path: urlPath,
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => { console.error('[GCal] HTTP error:', e.message); resolve(null); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Monta o objeto de evento Google Calendar a partir de uma visita do banco
function gcalEventFromVisita(v) {
  const tecnicos = (() => { try { return JSON.parse(v.tecnicos || '[]'); } catch { return []; } })();
  const tipoLabel = v.tipo === 'instalacao' ? 'Instalação' : v.tipo === 'manutencao' ? 'Manutenção' : 'Visita Técnica';
  const title = `${tipoLabel} – ${v.nome}`;
  const tecNomes = tecnicos.map(t => t.split('|')[0]).join(', ');
  const desc = [
    v.endereco ? `📍 ${v.endereco}` : '',
    v.cel ? `📱 ${v.cel}` : '',
    v.vendedora ? `👤 Vendedora: ${v.vendedora}` : '',
    v.lead_id ? `🔗 Lead: ${v.lead_id}` : '',
    v.periodo ? `🕐 ${v.periodo}` : '',
    tecNomes ? `👷 ${tecNomes}` : '',
    v.obs ? `📝 ${v.obs}` : ''
  ].filter(Boolean).join('\n');

  const datePart = v.data || new Date().toISOString().slice(0, 10);
  const tzOffset = '-03:00';
  let start, end;
  if (v.hora_ini) {
    start = { dateTime: `${datePart}T${v.hora_ini}:00${tzOffset}`, timeZone: 'America/Sao_Paulo' };
    // Fim sempre 1h depois do início
    const [h, m] = v.hora_ini.split(':').map(Number);
    const totalMin = h * 60 + m + 60;
    const hf = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
    const mf = String(totalMin % 60).padStart(2, '0');
    end = { dateTime: `${datePart}T${hf}:${mf}:00${tzOffset}`, timeZone: 'America/Sao_Paulo' };
  } else {
    start = { date: datePart };
    end = { date: datePart };
  }
  return { summary: title, description: desc, start, end, location: v.endereco || '' };
}

async function gcalSync(action, visita) {
  // action: 'create' | 'update' | 'delete'
  if (!_gcalSA || !_gcalId) return null;
  try {
    const token = await gcalGetToken();
    if (!token) return null;
    const base = `/calendar/v3/calendars/${encodeURIComponent(_gcalId)}/events`;

    if (action === 'create') {
      const r = await gcalHttpRequest('POST', base, token, gcalEventFromVisita(visita));
      if (r && r.body && r.body.id) { console.log('[GCal] Evento criado:', r.body.id); return r.body.id; }
      console.error('[GCal] Erro ao criar:', r?.body);
    } else if (action === 'update' && visita.google_event_id) {
      const r = await gcalHttpRequest('PUT', `${base}/${visita.google_event_id}`, token, gcalEventFromVisita(visita));
      if (r && r.status < 300) { console.log('[GCal] Evento atualizado:', visita.google_event_id); return visita.google_event_id; }
      console.error('[GCal] Erro ao atualizar:', r?.body);
    } else if (action === 'delete' && visita.google_event_id) {
      const r = await gcalHttpRequest('DELETE', `${base}/${visita.google_event_id}`, token, null);
      if (r && r.status < 300) { console.log('[GCal] Evento deletado:', visita.google_event_id); }
      else console.error('[GCal] Erro ao deletar:', r?.body);
    }
  } catch (e) {
    console.error('[GCal] gcalSync error:', e.message);
  }
  return null;
}

setupGoogleCalendar();

// ══════════════════════════════════════════════════════════════
// KOMMO CRM INTEGRATION
// Variáveis de ambiente necessárias:
//   KOMMO_TOKEN      → token de longa duração (JWT)
//   KOMMO_SUBDOMAIN  → ex: capelato
// ══════════════════════════════════════════════════════════════
const KOMMO_TOKEN     = process.env.KOMMO_TOKEN || '';
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN || '';

function kommoGet(path) {
  return new Promise((resolve, reject) => {
    if (!KOMMO_TOKEN || !KOMMO_SUBDOMAIN) return reject(new Error('Kommo não configurado'));
    const url = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4${path}`;
    const opts = {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${KOMMO_TOKEN}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(url, opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── BANCO DE DADOS ──
const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.NODE_ENV === 'production'
  ? path.join(DATA_DIR, 'capellato.db')
  : 'capellato.db';
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    login TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS visitas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT DEFAULT 'visita',
    nome TEXT NOT NULL,
    cel TEXT, endereco TEXT, cep TEXT,
    data TEXT, hora_ini TEXT, hora_fim TEXT, obs TEXT,
    tecnicos TEXT DEFAULT '[]',
    laudo TEXT DEFAULT NULL,
    fotos TEXT DEFAULT '[]',
    criado_por_id INTEGER, criado_por_nome TEXT,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS aprovacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL, vendedora TEXT, equip TEXT,
    valor REAL DEFAULT 0, custo REAL DEFAULT 0, margem REAL DEFAULT 0,
    pag TEXT, status TEXT DEFAULT 'pendente', texto TEXT,
    criado_por_id INTEGER, criado_por_nome TEXT,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS instalacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL, equip TEXT, pedido TEXT,
    valor REAL DEFAULT 0, mat REAL DEFAULT 0, sinal REAL DEFAULT 0, receber REAL DEFAULT 0,
    mat_comprar TEXT, data TEXT, vend TEXT, obs TEXT,
    anexos TEXT DEFAULT '[]', checks TEXT DEFAULT '{}',
    criado_por_id INTEGER, criado_por_nome TEXT,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER, usuario_nome TEXT,
    acao TEXT, tabela TEXT, registro_id INTEGER,
    dados_antes TEXT, dados_depois TEXT,
    momento TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS metas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendedora TEXT NOT NULL,
    ano INTEGER NOT NULL,
    mes INTEGER NOT NULL,
    meta_valor REAL DEFAULT 0,
    meta_pct REAL DEFAULT 0,
    supermeta_valor REAL DEFAULT 0,
    supermeta_pct REAL DEFAULT 0,
    UNIQUE(vendedora, ano, mes)
  );
`);
// migrate: add pct columns if missing
['meta_pct','supermeta_pct'].forEach(col => {
  try { db.prepare('ALTER TABLE metas ADD COLUMN ' + col + ' REAL DEFAULT 0').run(); } catch(e) {}
});
// migrate: add motivo_recusa if missing
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN motivo_recusa TEXT').run(); } catch(e) {}
try { db.prepare("ALTER TABLE aprovacoes ADD COLUMN temperatura_alvo TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE aprovacoes ADD COLUMN anexos TEXT DEFAULT '[]'").run(); } catch(e) {}
try { db.prepare("ALTER TABLE aprovacoes ADD COLUMN mat_prop REAL DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE aprovacoes ADD COLUMN custo_mat REAL DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE aprovacoes ADD COLUMN custo_prod REAL DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE aprovacoes ADD COLUMN aprovado_em TEXT DEFAULT NULL").run(); } catch(e) {}
// Corrigir aprovado_em do Elfo para junho/2026 (foi fechado em junho mas criado em maio)
try { db.prepare("UPDATE aprovacoes SET aprovado_em='2026-06-01' WHERE cliente LIKE '%Elfo%' AND status='aprovado' AND (aprovado_em IS NULL OR aprovado_em < '2026-06-01')").run(); } catch(e) {}


// ── CRIAR USUÁRIOS INICIAIS ──
function seed(nome, login, senha, role) {
  if (!db.prepare('SELECT id FROM usuarios WHERE login=?').get(login)) {
    db.prepare('INSERT INTO usuarios (nome,login,senha_hash,role) VALUES (?,?,?,?)').run(nome, login, bcrypt.hashSync(senha, 10), role);
  }
}
seed('Giulia Mendes', 'giulia', 'Flamengo@1', 'admin');


// ── SESSÕES NO SQLITE ──
db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
)`).run();
db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());

class SQLiteStore extends session.Store {
  get(sid, cb) {
    const row = db.prepare('SELECT data, expires FROM sessions WHERE sid=?').get(sid);
    if (!row || row.expires < Date.now()) return cb(null, null);
    try { cb(null, JSON.parse(row.data)); } catch(e) { cb(e); }
  }
  set(sid, sess, cb) {
    const exp = Date.now() + (sess.cookie?.maxAge || 30*24*60*60*1000);
    db.prepare('INSERT OR REPLACE INTO sessions (sid,data,expires) VALUES (?,?,?)').run(sid, JSON.stringify(sess), exp);
    cb && cb(null);
  }
  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);
    cb && cb(null);
  }
}

// ── MIDDLEWARE ──
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'capellato2024secret',
  resave: false, saveUninitialized: false,
  store: new SQLiteStore(),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

function auth(req, res, next) {
  if (!req.session.u) return res.status(401).json({ erro: 'Não autenticado' });
  next();
}
function adminOnly(req, res, next) {
  if (!req.session.u || req.session.u.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
  next();
}
function adminOrTecnico(req, res, next) {
  if (!req.session.u || !['admin','gerente','tecnico'].includes(req.session.u.role)) return res.status(403).json({ erro: 'Acesso negado' });
  next();
}
function audit(req, acao, tabela, regId, antes, depois) {
  const u = req.session.u;
  db.prepare('INSERT INTO auditoria (usuario_id,usuario_nome,acao,tabela,registro_id,dados_antes,dados_depois) VALUES (?,?,?,?,?,?,?)')
    .run(u?.id, u?.nome, acao, tabela, regId, antes ? JSON.stringify(antes) : null, depois ? JSON.stringify(depois) : null);
}

// ── LOGIN / LOGOUT ──
app.post('/api/login', (req, res) => {
  const { login, senha } = req.body;
  const u = db.prepare('SELECT * FROM usuarios WHERE login=? AND ativo=1').get(login);
  if (!u || !bcrypt.compareSync(senha, u.senha_hash)) return res.json({ sucesso: false, erro: 'Login ou senha incorretos' });
  req.session.u = { id: u.id, nome: u.nome, login: u.login, role: u.role };
  audit(req, 'LOGIN', 'usuarios', u.id, null, { login: u.login });
  res.json({ sucesso: true, usuario: req.session.u });
});
app.post('/api/logout', (req, res) => {
  if (req.session.u) audit(req, 'LOGOUT', 'usuarios', req.session.u.id, null, null);
  req.session.destroy(); res.json({ sucesso: true });
});
app.get('/api/me', (req, res) => {
  if (!req.session.u) return res.json({ autenticado: false });
  res.json({ autenticado: true, usuario: req.session.u });
});

// ── PERMISSÕES POR PERFIL ──
const DEFAULT_ROLE_PAGES = {
  admin:    ['dashboard','visita','calendario','proposta','aprovacao','pedidos','instalacao','financeiro','fechamentos','meta','calculadora','sincronizar','auditoria','parametros','usuarios','orcmat'],
  gerente:  ['dashboard','visita','calendario','proposta','aprovacao','pedidos','instalacao','financeiro','fechamentos','meta','calculadora','sincronizar','auditoria','orcmat'],
  vendedor: ['dashboard','visita','calendario','proposta','aprovacao','pedidos','meta','calculadora','sincronizar','orcmat'],
  tecnico:  ['dashboard','visita','calendario','instalacao','financeiro','calculadora','sincronizar','orcmat'],
  user:     ['dashboard','visita','calendario','proposta','aprovacao','calculadora','sincronizar'],
};
app.get('/api/role-permissions', auth, (req, res) => {
  const row = db.prepare("SELECT valor FROM config WHERE chave='role_permissions'").get();
  const saved = row ? JSON.parse(row.valor) : {};
  // admin sempre recebe a lista completa atualizada (ignora versão salva no banco)
  res.json({ ...DEFAULT_ROLE_PAGES, ...saved, admin: DEFAULT_ROLE_PAGES.admin });
});
app.put('/api/role-permissions', auth, adminOnly, (req, res) => {
  // admin sempre mantém acesso total
  const data = { ...req.body, admin: DEFAULT_ROLE_PAGES.admin };
  db.prepare("INSERT INTO config (chave,valor) VALUES ('role_permissions',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
    .run(JSON.stringify(data));
  audit(req, 'EDITAR_PERMISSOES', 'config', 0, null, data);
  res.json({ sucesso: true });
});

// ── PARÂMETROS DE PROPOSTA ──
const DEFAULT_PARAMS = {
  margem_prod: 38,    // % margem desejada de produto
  imposto_prod: 0,    // % imposto sobre produto
  imposto_mat: 8,     // % imposto sobre material (era hardcoded 8%)
};
app.get('/api/parametros', auth, (req, res) => {
  const row = db.prepare("SELECT valor FROM config WHERE chave='parametros_proposta'").get();
  const saved = row ? JSON.parse(row.valor) : {};
  res.json({ ...DEFAULT_PARAMS, ...saved });
});
app.put('/api/parametros', auth, adminOnly, (req, res) => {
  const data = { ...DEFAULT_PARAMS, ...req.body };
  db.prepare("INSERT INTO config (chave,valor) VALUES ('parametros_proposta',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
    .run(JSON.stringify(data));
  audit(req, 'EDITAR_PARAMETROS', 'config', 0, null, data);
  res.json({ sucesso: true });
});

// ── USUÁRIOS ──
app.get('/api/vendedoras', auth, (req, res) => {
  res.json(db.prepare("SELECT id,nome FROM usuarios WHERE role='vendedor' AND ativo=1 ORDER BY nome").all());
});
app.get('/api/usuarios', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,nome,login,role,ativo,criado_em FROM usuarios ORDER BY nome').all());
});
app.post('/api/usuarios', auth, adminOnly, (req, res) => {
  const { nome, login, senha, role } = req.body;
  if (!nome || !login || !senha) return res.json({ sucesso: false, erro: 'Preencha todos os campos' });
  if (db.prepare('SELECT id FROM usuarios WHERE login=?').get(login)) return res.json({ sucesso: false, erro: 'Login já existe' });
  const r = db.prepare('INSERT INTO usuarios (nome,login,senha_hash,role) VALUES (?,?,?,?)').run(nome, login, bcrypt.hashSync(senha, 10), role || 'user');
  audit(req, 'CRIAR_USUARIO', 'usuarios', r.lastInsertRowid, null, { nome, login, role });
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/usuarios/:id', auth, adminOnly, (req, res) => {
  const antes = db.prepare('SELECT id,nome,login,role,ativo FROM usuarios WHERE id=?').get(req.params.id);
  const { nome, role, ativo, senha } = req.body;
  if (senha) db.prepare('UPDATE usuarios SET nome=?,role=?,ativo=?,senha_hash=? WHERE id=?').run(nome, role, ativo, bcrypt.hashSync(senha, 10), req.params.id);
  else db.prepare('UPDATE usuarios SET nome=?,role=?,ativo=? WHERE id=?').run(nome, role, ativo, req.params.id);
  db.pragma('wal_checkpoint(FULL)'); // garante que a escrita é persistida no arquivo principal
  const depois = db.prepare('SELECT id,nome,login,role,ativo FROM usuarios WHERE id=?').get(req.params.id);
  audit(req, 'EDITAR_USUARIO', 'usuarios', req.params.id, antes, depois);
  res.json({ sucesso: true, role: depois.role });
});
app.delete('/api/usuarios/:id', auth, adminOnly, (req, res) => {
  const u = db.prepare('SELECT id,nome,login FROM usuarios WHERE id=?').get(req.params.id);
  if (!u) return res.json({ sucesso: false, erro: 'Usuário não encontrado' });
  if (u.login === 'giulia') return res.status(403).json({ sucesso: false, erro: 'Não é possível excluir este usuário' });
  db.prepare('DELETE FROM usuarios WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_USUARIO', 'usuarios', req.params.id, u, null);
  res.json({ sucesso: true });
});
app.post('/api/trocar-senha', auth, (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.session.u.id);
  if (!u || !bcrypt.compareSync(senhaAtual, u.senha_hash)) return res.json({ sucesso: false, erro: 'Senha atual incorreta' });
  db.prepare('UPDATE usuarios SET senha_hash=? WHERE id=?').run(bcrypt.hashSync(novaSenha, 10), u.id);
  audit(req, 'TROCAR_SENHA', 'usuarios', u.id, null, null);
  res.json({ sucesso: true });
});

// ── VISITAS ──
app.get('/api/visitas', auth, (req, res) => {
  const rows = db.prepare('SELECT id,tipo,nome,cel,endereco,cep,data,hora_ini,hora_fim,periodo,obs,tecnicos,vendedora,lead_id,laudo,criado_por_id,criado_por_nome,criado_em FROM visitas ORDER BY data ASC, hora_ini ASC, criado_em DESC').all().map(v => ({
    ...v,
    horaIni: v.hora_ini, horaFim: v.hora_fim, end: v.endereco, periodo: v.periodo,
    tecnicos: JSON.parse(v.tecnicos || '[]'), fotos: [], _tem_fotos: false,
    laudo: v.laudo ? JSON.parse(v.laudo) : null
  }));
  const comFotos = new Set(db.prepare("SELECT id FROM visitas WHERE fotos IS NOT NULL AND fotos != '[]' AND fotos != ''").all().map(r => r.id));
  rows.forEach(r => { r._tem_fotos = comFotos.has(r.id); });
  res.json(rows);
});
app.post('/api/visitas', auth, (req, res) => {
  const d = req.body;
  const r = db.prepare('INSERT INTO visitas (tipo,nome,cel,endereco,cep,data,hora_ini,hora_fim,periodo,obs,tecnicos,vendedora,lead_id,criado_por_id,criado_por_nome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(d.tipo, d.nome, d.cel, d.end, d.cep, d.data, d.horaIni, d.horaFim, d.periodo || null, d.obs, JSON.stringify(d.tecnicos || []), d.vendedora || null, d.lead_id || null, req.session.u.id, req.session.u.nome);
  audit(req, 'CRIAR_VISITA', 'visitas', r.lastInsertRowid, null, { nome: d.nome, data: d.data, tipo: d.tipo, vendedora: d.vendedora });
  res.json({ sucesso: true, id: r.lastInsertRowid });
  // Sync Google Calendar (assíncrono, não bloqueia a resposta)
  gcalSync('create', { tipo: d.tipo, nome: d.nome, cel: d.cel, endereco: d.end, data: d.data, hora_ini: d.horaIni, hora_fim: d.horaFim, periodo: d.periodo || null, obs: d.obs, tecnicos: JSON.stringify(d.tecnicos || []), vendedora: d.vendedora || null, lead_id: d.lead_id || null })
    .then(eventId => { if (eventId) db.prepare('UPDATE visitas SET google_event_id=? WHERE id=?').run(eventId, r.lastInsertRowid); })
    .catch(() => {});
});
app.put('/api/visitas/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT tipo,nome,cel,endereco,cep,data,hora_ini,hora_fim,obs,vendedora,google_event_id FROM visitas WHERE id=?').get(req.params.id);
  const d = req.body;
  db.prepare('UPDATE visitas SET tipo=?,nome=?,cel=?,endereco=?,cep=?,data=?,hora_ini=?,hora_fim=?,periodo=?,obs=?,tecnicos=?,vendedora=?,lead_id=? WHERE id=?')
    .run(d.tipo, d.nome, d.cel, d.end, d.cep, d.data, d.horaIni, d.horaFim, d.periodo || null, d.obs, JSON.stringify(d.tecnicos || []), d.vendedora || null, d.lead_id || null, req.params.id);
  audit(req, 'EDITAR_VISITA', 'visitas', req.params.id, antes, { nome: d.nome, data: d.data, tipo: d.tipo, vendedora: d.vendedora });
  res.json({ sucesso: true });
  // Sync Google Calendar
  if (antes) gcalSync('update', { ...antes, tipo: d.tipo, nome: d.nome, cel: d.cel, endereco: d.end, data: d.data, hora_ini: d.horaIni, hora_fim: d.horaFim, periodo: d.periodo || null, obs: d.obs, tecnicos: JSON.stringify(d.tecnicos || []), vendedora: d.vendedora || null, lead_id: d.lead_id || null }).catch(() => {});
});
app.put('/api/visitas/:id/laudo', auth, (req, res) => {
  const antes = db.prepare('SELECT laudo FROM visitas WHERE id=?').get(req.params.id);
  db.prepare('UPDATE visitas SET laudo=?,fotos=? WHERE id=?').run(JSON.stringify(req.body.laudo), JSON.stringify(req.body.fotos || []), req.params.id);
  audit(req, 'SALVAR_LAUDO', 'visitas', req.params.id, antes?.laudo ? JSON.parse(antes.laudo) : null, req.body.laudo);
  res.json({ sucesso: true });
});
app.delete('/api/visitas/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT nome,data,tipo,google_event_id FROM visitas WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM visitas WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_VISITA', 'visitas', req.params.id, antes, null);
  res.json({ sucesso: true });
  // Sync Google Calendar
  if (antes) gcalSync('delete', antes).catch(() => {});
});
app.get('/api/visitas/:id/fotos', auth, (req, res) => {
  const row = db.prepare('SELECT fotos FROM visitas WHERE id=?').get(req.params.id);
  if (!row) return res.json([]);
  try { res.json(JSON.parse(row.fotos || '[]')); } catch(e) { res.json([]); }
});

// ── NÚMERO DE PROPOSTA SEQUENCIAL ──
app.post('/api/proposta/numero', auth, (req, res) => {
  const row = db.prepare('SELECT valor FROM config WHERE chave=?').get('proposta_contador');
  const atual = row ? Math.max(parseInt(row.valor), 2025) : 2025;
  const proximo = atual + 1;
  db.prepare('INSERT INTO config (chave, valor) VALUES (?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run('proposta_contador', String(proximo));
  res.json({ numero: proximo });
});

// ── APROVAÇÕES ──
app.get('/api/aprovacoes', auth, (req, res) => {
  // Não retorna o campo 'anexos' (base64 pesado) na listagem — carregado sob demanda
  const rows = db.prepare('SELECT id,cliente,vendedora,equip,valor,custo,margem,pag,status,texto,custos,motivo_recusa,temperatura_alvo,mat_prop,custo_mat,custo_prod,lead_id,visita_id,orcmat_id,criado_por_id,criado_por_nome,criado_em,aprovado_em FROM aprovacoes ORDER BY criado_em DESC').all();
  rows.forEach(r => { r.anexos = []; r._tem_anexos = false; });
  // Marca quais têm anexos sem carregar os dados
  const comAnexos = db.prepare("SELECT id FROM aprovacoes WHERE anexos IS NOT NULL AND anexos != '[]' AND anexos != ''").all().map(r => r.id);
  const setAnexos = new Set(comAnexos);
  rows.forEach(r => { r._tem_anexos = setAnexos.has(r.id); });
  res.json(rows);
});
app.get('/api/aprovacoes/:id/html', auth, (req, res) => {
  const row = db.prepare('SELECT html_proposta FROM aprovacoes WHERE id=?').get(req.params.id);
  if (!row) return res.json({ html_proposta: null });
  res.json({ html_proposta: row.html_proposta || null });
});
app.get('/api/aprovacoes/:id/anexos', auth, (req, res) => {
  const row = db.prepare('SELECT anexos FROM aprovacoes WHERE id=?').get(req.params.id);
  if (!row) return res.json([]);
  try { res.json(JSON.parse(row.anexos || '[]')); } catch(e) { res.json([]); }
});
app.post('/api/aprovacoes', auth, (req, res) => {
  const d = req.body;
  const r = db.prepare('INSERT INTO aprovacoes (cliente,vendedora,equip,valor,custo,margem,pag,status,texto,custos,html_proposta,temperatura_alvo,anexos,mat_prop,custo_mat,custo_prod,visita_id,orcmat_id,lead_id,criado_por_id,criado_por_nome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(d.cliente, d.vendedora, d.equip, d.valor, d.custo, d.margem, d.pag, 'pendente', d.texto, d.custos || null, d.html_proposta || null, d.temperatura_alvo || null, JSON.stringify(d.anexos || []), d.mat_prop || 0, d.custo_mat || 0, d.custo_prod || 0, d.visita_id || null, d.orcmat_id || null, d.lead_id || null, req.session.u.id, req.session.u.nome);
  audit(req, 'CRIAR_PROPOSTA', 'aprovacoes', r.lastInsertRowid, null, { cliente: d.cliente, valor: d.valor });
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/aprovacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,valor,status,texto,aprovado_em FROM aprovacoes WHERE id=?').get(req.params.id);
  const d = req.body;
  // Grava aprovado_em: respeita valor enviado pelo cliente, ou define hoje quando aprovado pela primeira vez
  const aprovadoEm = d.aprovado_em
    ? d.aprovado_em
    : (d.status === 'aprovado' && antes.status !== 'aprovado')
      ? new Date().toISOString().slice(0, 10)
      : (antes.aprovado_em || null);
  db.prepare('UPDATE aprovacoes SET cliente=?,vendedora=?,equip=?,valor=?,custo=?,margem=?,pag=?,status=?,texto=?,custos=?,html_proposta=COALESCE(html_proposta,?),motivo_recusa=?,temperatura_alvo=?,anexos=COALESCE(?,anexos),mat_prop=?,custo_mat=?,custo_prod=?,visita_id=COALESCE(?,visita_id),orcmat_id=COALESCE(?,orcmat_id),lead_id=COALESCE(?,lead_id),aprovado_em=? WHERE id=?')
    .run(d.cliente, d.vendedora, d.equip, d.valor, d.custo, d.margem, d.pag, d.status, d.texto, d.custos || null, d.html_proposta || null, d.motivo_recusa || null, d.temperatura_alvo || null, d.anexos ? JSON.stringify(d.anexos) : null, d.mat_prop || 0, d.custo_mat || 0, d.custo_prod || 0, d.visita_id || null, d.orcmat_id || null, d.lead_id || null, aprovadoEm, req.params.id);
  audit(req, 'EDITAR_PROPOSTA', 'aprovacoes', req.params.id, antes, { cliente: d.cliente, valor: d.valor, status: d.status });
  res.json({ sucesso: true });
});
app.delete('/api/aprovacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,valor FROM aprovacoes WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM aprovacoes WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_PROPOSTA', 'aprovacoes', req.params.id, antes, null);
  res.json({ sucesso: true });
});

// ── INSTALAÇÕES ──
app.get('/api/instalacoes', auth, (req, res) => {
  const rows = db.prepare('SELECT id,cliente,equip,pedido,valor,mat,sinal,receber,mat_comprar,data,vend,obs,checks,comprovante_pag,comprovantes,lead_id,pedido_ref,tipo_servico,custos,obs_compras,transferencia,visita_ref_id,criado_por_id,criado_por_nome,criado_em,datas,datas_obs,datas_ok FROM instalacoes ORDER BY criado_em DESC').all().map(i => {
    let comprovantes = JSON.parse(i.comprovantes || 'null');
    if (!comprovantes) comprovantes = i.comprovante_pag ? [i.comprovante_pag] : [];
    let matComprar = [];
    try {
      const mc = JSON.parse(i.mat_comprar || 'null');
      if (Array.isArray(mc)) matComprar = mc;
      else if (mc && typeof mc === 'string' && mc.trim()) matComprar = [{ nome: mc, ok: false }];
      else if (i.mat_comprar && i.mat_comprar.trim()) matComprar = [{ nome: i.mat_comprar, ok: false }];
    } catch(e) { if (i.mat_comprar && i.mat_comprar.trim()) matComprar = [{ nome: i.mat_comprar, ok: false }]; }
    let transfItens = [];
    try {
      const t = JSON.parse(i.transferencia || 'null');
      if (Array.isArray(t)) transfItens = t;
      else if (typeof t === 'string' && t.trim()) transfItens = [{ nome: t, ok: false, qtd: 1 }];
      else if (i.transferencia && i.transferencia.trim()) transfItens = [{ nome: i.transferencia, ok: false, qtd: 1 }];
    } catch(e) { if (i.transferencia && i.transferencia.trim()) transfItens = [{ nome: i.transferencia, ok: false, qtd: 1 }]; }
    const datas   = JSON.parse(i.datas    || 'null') || [];
    const datasObs = JSON.parse(i.datas_obs || 'null') || [];
    const datasOk  = JSON.parse(i.datas_ok  || 'null') || [];
    return { ...i, matComprar, transfItens, anexos: [], _tem_anexos: false, checks: JSON.parse(i.checks || '{}'), comprovantes, datas, datas_obs: datasObs, datas_ok: datasOk };
  });
  const comAnexos = new Set(db.prepare("SELECT id FROM instalacoes WHERE anexos IS NOT NULL AND anexos != '[]' AND anexos != ''").all().map(r => r.id));
  rows.forEach(r => { r._tem_anexos = comAnexos.has(r.id); });
  res.json(rows);
});
app.post('/api/instalacoes', auth, (req, res) => {
  const d = req.body;
  const r = db.prepare('INSERT INTO instalacoes (cliente,equip,pedido,valor,mat,sinal,receber,mat_comprar,data,vend,obs,anexos,checks,criado_por_id,criado_por_nome,lead_id,pedido_ref,custos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(d.cliente, d.equip, d.pedido, d.valor, d.mat, d.sinal, d.receber, Array.isArray(d.matComprar) ? JSON.stringify(d.matComprar) : (d.matComprar || null), d.data, d.vend, d.obs, JSON.stringify(d.anexos || []), JSON.stringify(d.checks || {}), req.session.u.id, req.session.u.nome, d.lead_id || null, d.pedido_ref || null, d.custos || null);
  audit(req, 'CRIAR_INSTALACAO', 'instalacoes', r.lastInsertRowid, null, { cliente: d.cliente, equip: d.equip });
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/instalacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,equip,valor,checks FROM instalacoes WHERE id=?').get(req.params.id);
  const d = req.body;
  db.prepare('UPDATE instalacoes SET cliente=?,equip=?,pedido=?,valor=?,mat=?,sinal=?,receber=?,mat_comprar=?,data=?,vend=?,obs=?,anexos=?,checks=?,lead_id=?,pedido_ref=?,datas=?,datas_obs=?,datas_ok=?,transferencia=? WHERE id=?')
    .run(d.cliente, d.equip, d.pedido, d.valor, d.mat, d.sinal, d.receber, Array.isArray(d.matComprar) ? JSON.stringify(d.matComprar) : (d.matComprar || null), d.data, d.vend, d.obs, JSON.stringify(d.anexos || []), JSON.stringify(d.checks || {}), d.lead_id || null, d.pedido_ref || null,
        Array.isArray(d.datas) ? JSON.stringify(d.datas) : null,
        Array.isArray(d.datas_obs) ? JSON.stringify(d.datas_obs) : null,
        Array.isArray(d.datas_ok) ? JSON.stringify(d.datas_ok) : null,
        d.transferencia || null,
        req.params.id);
  audit(req, 'EDITAR_INSTALACAO', 'instalacoes', req.params.id, antes ? { ...antes, checks: JSON.parse(antes.checks || '{}') } : null, { cliente: d.cliente, equip: d.equip });
  res.json({ sucesso: true });
});
app.put('/api/instalacoes/:id/compras', auth, (req, res) => {
  const antes = db.prepare('SELECT * FROM instalacoes WHERE id=?').get(req.params.id);
  const d = req.body;
  db.prepare('UPDATE instalacoes SET mat=?,sinal=?,receber=?,mat_comprar=?,checks=?,tipo_servico=?,data=?,custos=?,comprovante_pag=?,comprovantes=?,obs_compras=?,transferencia=? WHERE id=?')
    .run(d.mat, d.sinal, d.receber, Array.isArray(d.matComprar) ? JSON.stringify(d.matComprar) : (d.matComprar || null), JSON.stringify(d.checks || {}), d.tipo_servico || 'instalacao', d.data || null, d.custos || null, d.comprovante_pag || null, JSON.stringify(d.comprovantes || []), d.obs_compras || null, Array.isArray(d.transfItens) ? JSON.stringify(d.transfItens) : null, req.params.id);
  audit(req, 'EDITAR_COMPRAS', 'instalacoes', req.params.id,
    antes ? { mat: antes.mat, sinal: antes.sinal, receber: antes.receber, matComprar: antes.mat_comprar, checks: JSON.parse(antes.checks || '{}') } : null,
    { mat: d.mat, sinal: d.sinal, receber: d.receber, matComprar: d.matComprar, checks: d.checks, tipo_servico: d.tipo_servico });

  res.json({ sucesso: true });
});
app.delete('/api/instalacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,equip FROM instalacoes WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM instalacoes WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_INSTALACAO', 'instalacoes', req.params.id, antes, null);
  res.json({ sucesso: true });
});
app.get('/api/instalacoes/:id/anexos', auth, (req, res) => {
  const row = db.prepare('SELECT anexos FROM instalacoes WHERE id=?').get(req.params.id);
  if (!row) return res.json([]);
  try { res.json(JSON.parse(row.anexos || '[]')); } catch(e) { res.json([]); }
});

// ── METAS ──
app.get('/api/metas', auth, (req, res) => {
  const { ano, mes } = req.query;
  const rows = (ano && mes)
    ? db.prepare('SELECT * FROM metas WHERE ano=? AND mes=?').all(ano, mes)
    : db.prepare('SELECT * FROM metas').all();
  res.json(rows);
});
app.put('/api/metas', auth, (req, res) => {
  const { vendedora, ano, mes, meta_valor, meta_pct, supermeta_valor, supermeta_pct } = req.body;
  db.prepare('INSERT INTO metas (vendedora,ano,mes,meta_valor,meta_pct,supermeta_valor,supermeta_pct) VALUES (?,?,?,?,?,?,?) ON CONFLICT(vendedora,ano,mes) DO UPDATE SET meta_valor=excluded.meta_valor, meta_pct=excluded.meta_pct, supermeta_valor=excluded.supermeta_valor, supermeta_pct=excluded.supermeta_pct')
    .run(vendedora, ano, mes, meta_valor||0, meta_pct||0, supermeta_valor||0, supermeta_pct||0);
  res.json({ sucesso: true });
});

// ── AUDITORIA ──
app.get('/api/auditoria', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM auditoria ORDER BY momento DESC LIMIT 1000').all());
});

// ── TINY ERP ──
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN tiny_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN tiny_proposta_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN html_proposta TEXT DEFAULT NULL').run(); } catch(e) {}

app.get('/api/config/tiny', auth, adminOnly, (req, res) => {
  const row = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!row) return res.json({ configurado: false });
  res.json({ configurado: true, preview: '****' + row.valor.slice(-4) });
});

app.put('/api/config/tiny', auth, adminOnly, (req, res) => {
  const { token } = req.body;
  if (!token || token.trim().length < 10) return res.status(400).json({ erro: 'Token inválido.' });
  db.prepare("INSERT INTO config (chave,valor) VALUES ('tiny_token',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor").run(token.trim());
  audit(req, 'CONFIG_TINY', 'config', 0, null, { token: '****' + token.trim().slice(-4) });
  res.json({ sucesso: true });
});

function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Normalize accented chars to ASCII — Tiny API v2 (PHP) has UTF-8 issues in form-urlencoded
function toAscii(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics (á→a, ç→c, ã→a, etc.)
    .replace(/[^\x00-\x7F]/g, '');     // drop any remaining non-ASCII
}

// Remove HTML tags, normalizes special chars, strips control chars — safe for Tiny XML fields
function tinyStr(s, maxLen) {
  let r = String(s ?? '');
  r = r.replace(/<[^>]*>/g, ' ');
  r = r.replace(/•/g, '-').replace(/—/g, '-').replace(/–/g, '-');
  r = r.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  r = r.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  r = toAscii(r);
  if (maxLen && r.length > maxLen) r = r.slice(0, maxLen);
  return xmlEsc(r);
}
// Same sanitization without XML escaping — for JSON payload
function tinyJson(s, maxLen) {
  let r = String(s ?? '');
  r = r.replace(/<[^>]*>/g, ' ');
  r = r.replace(/•/g, '-').replace(/—/g, '-').replace(/–/g, '-');
  r = r.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  r = r.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  r = toAscii(r);
  if (maxLen && r.length > maxLen) r = r.slice(0, maxLen);
  return r;
}
function buildPedidoJson(cliente, equip, valorStr, dataBr, obs) {
  return JSON.stringify({
    data_pedido: dataBr,
    situacao: 'Em aberto',
    contato: { nome: tinyJson(cliente, 100) },
    obs: tinyJson(obs, 500),
    itens: { item: [{ descricao: tinyJson(equip || 'Equipamento', 500), unidade: 'UN', quantidade: '1', valor_unitario: valorStr }] }
  });
}

app.post('/api/tiny/enviar/:id', auth, adminOnly, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado. Configure em Usuários.' });
  const a = db.prepare('SELECT * FROM aprovacoes WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ erro: 'Proposta não encontrada.' });
  const hoje = new Date();
  const dataBr = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
  const obs = `Vendedora: ${a.vendedora || ''}. Pagamento: ${a.pag || ''}.`;
  const valorStr = (parseFloat(a.valor) || 0).toFixed(2).replace('.', ',');
  const pedidoJson = buildPedidoJson(a.cliente, a.equip, valorStr, dataBr, obs);
  try {
    const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pedido: pedidoJson }).toString();
    console.log('[TINY ENVIAR] JSON:', pedidoJson);
    const resp = await fetch('https://api.tiny.com.br/api2/pedido.incluir.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const rawText = await resp.text();
    console.log('[TINY ENVIAR] Resposta:', rawText);
    const d = JSON.parse(rawText);
    if (d.retorno?.status === 'OK') {
      const tinyId = String(d.retorno?.registros?.registro?.id || '');
      db.prepare('UPDATE aprovacoes SET tiny_id=? WHERE id=?').run(tinyId || 'enviado', req.params.id);
      audit(req, 'ENVIAR_TINY', 'aprovacoes', req.params.id, null, { tiny_id: tinyId, cliente: a.cliente });
      return res.json({ sucesso: true, tiny_id: tinyId });
    }
    const erro = d.retorno?.erros?.[0]?.erro || d.retorno?.registros?.[0]?.registro?.erros?.[0]?.erro || d.retorno?.status || 'Erro desconhecido da API Tiny.';
    console.log('[TINY ENVIAR] Erro:', erro, 'Retorno:', JSON.stringify(d.retorno));
    res.status(400).json({ erro });
  } catch(e) {
    console.log('[TINY ENVIAR] Exceção:', e.message);
    res.status(500).json({ erro: 'Erro de conexão com Tiny: ' + e.message });
  }
});

app.post('/api/tiny/proposta/:id', auth, adminOnly, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado. Configure em Usuários.' });
  const a = db.prepare('SELECT * FROM aprovacoes WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ erro: 'Aprovação não encontrada.' });
  const hoje = new Date();
  const dataBr = `${String(hoje.getDate()).padStart(2,'0')}/${String(hoje.getMonth()+1).padStart(2,'0')}/${hoje.getFullYear()}`;
  const obs = `ORCAMENTO. Vendedora: ${a.vendedora || ''}. Pagamento: ${a.pag || ''}.`;
  const valorStr = (parseFloat(a.valor) || 0).toFixed(2).replace('.', ',');
  const pedidoJson = buildPedidoJson(a.cliente, a.equip, valorStr, dataBr, obs);
  try {
    const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pedido: pedidoJson }).toString();
    console.log('[TINY PROPOSTA] JSON:', pedidoJson);
    const resp = await fetch('https://api.tiny.com.br/api2/pedido.incluir.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const rawText = await resp.text();
    console.log('[TINY PROPOSTA] Resposta:', rawText);
    const d = JSON.parse(rawText);
    if (d.retorno?.status === 'OK') {
      const propostaId = String(d.retorno?.registros?.registro?.id || '');
      db.prepare('UPDATE aprovacoes SET tiny_proposta_id=? WHERE id=?').run(propostaId || 'enviado', req.params.id);
      audit(req, 'ENVIAR_TINY_PROPOSTA', 'aprovacoes', req.params.id, null, { tiny_proposta_id: propostaId, cliente: a.cliente });
      return res.json({ sucesso: true, tiny_proposta_id: propostaId });
    }
    const erro = d.retorno?.erros?.[0]?.erro || d.retorno?.registros?.[0]?.registro?.erros?.[0]?.erro || d.retorno?.status || 'Erro desconhecido da API Tiny.';
    console.log('[TINY PROPOSTA] Erro:', erro, 'Retorno:', JSON.stringify(d.retorno));
    res.status(400).json({ erro });
  } catch(e) {
    console.log('[TINY PROPOSTA] Exceção:', e.message);
    res.status(500).json({ erro: 'Erro de conexão com Tiny: ' + e.message });
  }
});

// ── PEDIDOS UNIFICADOS ──
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN lead_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN lead_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN pedido_ref TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE tiny_pedidos ADD COLUMN lead_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare("ALTER TABLE instalacoes ADD COLUMN tipo_servico TEXT DEFAULT 'instalacao'").run(); } catch(e) {}
try { db.prepare('ALTER TABLE visitas ADD COLUMN vendedora TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE visitas ADD COLUMN lead_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE visitas ADD COLUMN google_event_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE visitas ADD COLUMN periodo TEXT DEFAULT NULL').run(); } catch(e) {}
// garantir que o contador de proposta começa em pelo menos 2025 (próximo número = 2026+)
try {
  const cRow = db.prepare("SELECT valor FROM config WHERE chave='proposta_contador'").get();
  if (!cRow || parseInt(cRow.valor) < 2025) {
    db.prepare("INSERT INTO config (chave,valor) VALUES ('proposta_contador','2025') ON CONFLICT(chave) DO UPDATE SET valor='2025'").run();
  }
} catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN custos TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN comprovante_pag TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN visita_ref_id INTEGER DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN custos TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN comprovantes TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN obs_compras TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN datas TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN datas_obs TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN datas_ok TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE instalacoes ADD COLUMN transferencia TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE orcamentos_mat ADD COLUMN visita_id INTEGER DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE orcamentos_mat ADD COLUMN laudo TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN visita_id INTEGER DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN orcmat_id INTEGER DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE materiais_catalogo ADD COLUMN preco_custo REAL DEFAULT 0').run(); } catch(e) {}

// ── ORÇAMENTOS DE MATERIAIS ──
db.exec(`
  CREATE TABLE IF NOT EXISTS materiais_catalogo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT,
    nome TEXT NOT NULL,
    unidade TEXT DEFAULT 'UN',
    preco_venda REAL DEFAULT 0,
    ativo INTEGER DEFAULT 1,
    criado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS orcamentos_mat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL,
    visita_id INTEGER DEFAULT NULL,
    status TEXT DEFAULT 'rascunho',
    obs TEXT DEFAULT NULL,
    valor_total REAL DEFAULT 0,
    criado_por TEXT DEFAULT NULL,
    criado_em TEXT DEFAULT (datetime('now','localtime')),
    atualizado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS orcamentos_mat_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orcamento_id INTEGER NOT NULL,
    sku TEXT DEFAULT NULL,
    nome TEXT NOT NULL,
    unidade TEXT DEFAULT 'UN',
    quantidade REAL DEFAULT 1,
    preco_unit REAL DEFAULT 0,
    preco_total REAL DEFAULT 0,
    obs TEXT DEFAULT NULL,
    estoque_tiny TEXT DEFAULT NULL,
    ordem INTEGER DEFAULT 0
  );
`);
// Normaliza vendedora em tiny_pedidos para nome canônico (corrige registros com nome em minúsculo do tag Tiny)
try {
  const normS2 = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const vendsDB2 = db.prepare("SELECT nome FROM usuarios WHERE role='vendedor' AND ativo=1").all().map(u => u.nome);
  const rows = db.prepare("SELECT id,vendedora FROM tiny_pedidos WHERE vendedora IS NOT NULL AND vendedora != ''").all();
  const upd = db.prepare("UPDATE tiny_pedidos SET vendedora=? WHERE id=?");
  rows.forEach(row => {
    const nt = normS2(row.vendedora);
    const canonical = vendsDB2.find(v => { const nv=normS2(v); return nv===nt||nv.includes(nt)||nt.includes(nv); });
    if (canonical && canonical !== row.vendedora) upd.run(canonical, row.id);
    else if (!canonical) upd.run(null, row.id);
  });
} catch(e) {}
// Remove visitas criadas automaticamente pelo sync antigo de compras
try {
  db.prepare('DELETE FROM visitas WHERE id IN (SELECT visita_ref_id FROM instalacoes WHERE visita_ref_id IS NOT NULL)').run();
  db.prepare('UPDATE instalacoes SET visita_ref_id=NULL WHERE visita_ref_id IS NOT NULL').run();
} catch(e) {}

app.get('/api/pedidos', auth, (req, res) => {
  const tinys = db.prepare("SELECT id,'tiny' as fonte,numero,cliente,vendedora,valor,data,situacao,lead_id FROM tiny_pedidos ORDER BY data DESC").all();
  res.json(tinys);
});
app.put('/api/pedidos/aprov/:id/lead', auth, (req, res) => {
  db.prepare('UPDATE aprovacoes SET lead_id=? WHERE id=?').run(req.body.lead_id || null, req.params.id);
  res.json({ sucesso: true });
});
app.put('/api/aprovacoes/:id/orcmat', auth, (req, res) => {
  const val = req.body.orcmat_id !== undefined ? req.body.orcmat_id : null;
  db.prepare('UPDATE aprovacoes SET orcmat_id=? WHERE id=?').run(val, req.params.id);
  res.json({ sucesso: true });
});
app.put('/api/pedidos/tiny/:id/lead', auth, (req, res) => {
  db.prepare('UPDATE tiny_pedidos SET lead_id=? WHERE id=?').run(req.body.lead_id || null, req.params.id);
  res.json({ sucesso: true });
});
app.put('/api/pedidos/aprov/:id/vendedora', auth, (req, res) => {
  db.prepare('UPDATE aprovacoes SET vendedora=? WHERE id=?').run(req.body.vendedora || null, req.params.id);
  res.json({ sucesso: true });
});
app.put('/api/pedidos/tiny/:id/vendedora', auth, (req, res) => {
  db.prepare('UPDATE tiny_pedidos SET vendedora=? WHERE id=?').run(req.body.vendedora || null, req.params.id);
  res.json({ sucesso: true });
});
app.delete('/api/pedidos/tiny/:id', auth, adminOnly, (req, res) => {
  const r = db.prepare('DELETE FROM tiny_pedidos WHERE id=?').run(req.params.id);
  audit(req, 'REMOVER_PEDIDO_TINY', 'tiny_pedidos', req.params.id, null, null);
  res.json({ sucesso: r.changes > 0 });
});
app.put('/api/instalacoes/:id/lead', auth, (req, res) => {
  db.prepare('UPDATE instalacoes SET lead_id=? WHERE id=?').run(req.body.lead_id || null, req.params.id);
  res.json({ sucesso: true });
});

// ── TINY WEBHOOK (notificação automática do Tiny ao incluir/alterar pedido) ──
// URL para configurar no Tiny: https://alery.fly.dev/api/tiny/notificacao
app.post('/api/tiny/notificacao', async (req, res) => {
  res.json({ ok: true }); // responde rápido para o Tiny não retentar
  try {
    const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
    if (!tokenRow) return;
    // Tiny envia: dados={"id":123,...}&tipo=pedido (form-urlencoded ou JSON)
    let pedidoId = null;
    const raw = req.body;
    if (raw?.dados) {
      try { const d = JSON.parse(raw.dados); pedidoId = String(d.id || ''); } catch(e) {}
    }
    if (!pedidoId && raw?.id) pedidoId = String(raw.id);
    if (!pedidoId) return;
    // Busca detalhe do pedido
    const detBody = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id: pedidoId }).toString();
    const detResp = await fetch('https://api.tiny.com.br/api2/pedido.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: detBody });
    const det = await detResp.json();
    const ped = det?.retorno?.pedido;
    if (!ped) {
      // Pedido não encontrado no Tiny — foi excluído
      db.prepare("DELETE FROM tiny_pedidos WHERE tiny_id=?").run(pedidoId);
      return;
    }
    // Só importa se NÃO tiver vínculo ecommerce (loja física)
    const numEc = String(ped.numero_ecommerce || ped.numeroPedidoEcommerce || '').trim();
    if (numEc) return;
    // Extrai marcadores para detectar vendedora
    let tags = [];
    if (Array.isArray(ped.marcadores)) tags = ped.marcadores.map(m => String(m.marcador?.descricao || m.descricao || m).toLowerCase());
    else if (typeof ped.marcadores === 'string' && ped.marcadores) tags = ped.marcadores.split(',').map(s => s.trim().toLowerCase());
    const normS = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const tagVend = tags.find(t => !normS(t).includes('loja') && !normS(t).includes('1') && t.trim()) || '';
    const vendsDB = db.prepare("SELECT nome FROM usuarios WHERE role='vendedor' AND ativo=1").all().map(u => u.nome);
    const vendedora = vendsDB.find(v => { const a=normS(v),b=normS(tagVend); return b && (a===b||a.includes(b)||b.includes(a)); }) || '';
    let data = String(ped.data_pedido || ped.data || '');
    if (data.includes('/')) { const pts = data.split('/'); data = `${pts[2]}-${pts[1]}-${pts[0]}`; }
    const valor = parseFloat(String(ped.valor || '0').replace(',', '.')) || 0;
    db.prepare(`INSERT INTO tiny_pedidos (tiny_id,numero,cliente,valor,data,vendedora,marcadores,situacao)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tiny_id) DO UPDATE SET
      numero=excluded.numero, cliente=excluded.cliente, valor=excluded.valor, data=excluded.data,
      situacao=excluded.situacao, marcadores=excluded.marcadores,
      vendedora=CASE WHEN tiny_pedidos.vendedora IS NULL OR tiny_pedidos.vendedora='' THEN excluded.vendedora ELSE tiny_pedidos.vendedora END,
      sincronizado_em=datetime('now','localtime')`)
      .run(String(ped.id), String(ped.numero || ''), ped.nome || '', valor, data, vendedora, JSON.stringify(tags), ped.situacao || '');
  } catch(e) { /* silencioso — já respondeu 200 */ }
});

// ── SYNC GOOGLE CALENDAR EM MASSA ──
app.post('/api/gcal/sync-todas-visitas', auth, adminOnly, async (req, res) => {
  if (!_gcalSA || !_gcalId) return res.status(400).json({ erro: 'Google Calendar não configurado' });
  const visitas = db.prepare('SELECT * FROM visitas ORDER BY data ASC').all();
  res.json({ iniciado: true, total: visitas.length });
  // Roda em background sem bloquear
  (async () => {
    let ok = 0, erros = 0;
    for (const v of visitas) {
      try {
        const visita = { ...v, tecnicos: v.tecnicos || '[]' };
        if (v.google_event_id) {
          // Já tem evento — atualiza com dados mais recentes
          await gcalSync('update', visita);
          ok++;
        } else {
          // Ainda não tem evento — cria
          const eventId = await gcalSync('create', visita);
          if (eventId) {
            db.prepare('UPDATE visitas SET google_event_id=? WHERE id=?').run(eventId, v.id);
            ok++;
          } else { erros++; }
        }
        // Pequena pausa para não sobrecarregar a API do Google (quota: 10 req/s)
        await new Promise(r => setTimeout(r, 120));
      } catch(e) { erros++; }
    }
    console.log(`[GCal] Sync em massa concluído: ${ok} ok, ${erros} erros`);
  })();
});

// ── TINY DEBUG ──
app.get('/api/tiny/debug', auth, adminOnly, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token não configurado.' });
  const hoje = new Date();
  const mes = String(hoje.getMonth()+1).padStart(2,'0');
  const ano = hoje.getFullYear();
  try {
    // Tenta mês atual, senão mês anterior
    const listBody = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', dataInicial: `01/01/${ano}`, dataFinal: `21/${mes}/${ano}`, pagina: '1' }).toString();
    const listResp = await fetch('https://api.tiny.com.br/api2/pedidos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: listBody });
    const listData = await listResp.json();
    const pedidos = Array.isArray(listData.retorno?.pedidos) ? listData.retorno.pedidos : [];
    const primeiros3 = pedidos.slice(0, 3).map(p => p.pedido || p);
    // Fetch detail of first item
    const firstItem = primeiros3[0];
    let detalhe = null;
    if (firstItem?.id) {
      const detBody = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id: String(firstItem.id) }).toString();
      const detResp = await fetch('https://api.tiny.com.br/api2/pedido.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: detBody });
      detalhe = await detResp.json();
    }
    res.json({
      lista_status: listData.retorno?.status,
      lista_erros: listData.retorno?.erros,
      numero_paginas: listData.retorno?.numero_paginas,
      total_nesta_pagina: pedidos.length,
      periodo_buscado: `01/01/${ano} a 21/${mes}/${ano}`,
      primeiros3_lista_raw: primeiros3,
      detalhe_primeiro: detalhe?.retorno
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── TINY PEDIDOS LOJA FÍSICA ──
db.exec(`
  CREATE TABLE IF NOT EXISTS tiny_pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tiny_id TEXT UNIQUE NOT NULL,
    numero TEXT,
    cliente TEXT,
    valor REAL DEFAULT 0,
    data TEXT,
    vendedora TEXT,
    marcadores TEXT,
    situacao TEXT,
    lead_id TEXT DEFAULT NULL,
    sincronizado_em TEXT DEFAULT (datetime('now','localtime'))
  )
`);
// Garante colunas extras em DBs antigos
try { db.prepare('ALTER TABLE tiny_pedidos ADD COLUMN lead_id TEXT DEFAULT NULL').run(); } catch(e) {}

function detectarVendedoraTiny(tags) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const excluir = ['loja fisica', 'loja f', '1a venda', '1 venda'];
  return tags.find(t => !excluir.some(e => norm(t).includes(e))) || '';
}

app.post('/api/tiny/sincronizar', auth, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado.' });
  const { dataInicial, dataFinal } = req.body;
  if (!dataInicial || !dataFinal) return res.status(400).json({ erro: 'Informe o período.' });
  const toDDMMYYYY = s => s.split('-').reverse().join('/');
  const stmt = db.prepare(`INSERT INTO tiny_pedidos (tiny_id,numero,cliente,valor,data,vendedora,marcadores,situacao)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tiny_id) DO UPDATE SET
    numero=excluded.numero, cliente=excluded.cliente, valor=excluded.valor, data=excluded.data,
    situacao=excluded.situacao, marcadores=excluded.marcadores,
    vendedora=CASE WHEN tiny_pedidos.vendedora IS NULL OR tiny_pedidos.vendedora='' THEN excluded.vendedora ELSE tiny_pedidos.vendedora END,
    sincronizado_em=datetime('now','localtime')`);
  let total = 0, pagina = 1, totalPags = 1;
  const normS = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const isLojaFisica = tags => tags.some(t => normS(t).includes('loja') && normS(t).includes('fisica'));
  const getVendedoraMarcador = tags => tags.find(t => !normS(t).includes('loja') && !normS(t).includes('1') && t.trim()) || '';
  const vendsDB = db.prepare("SELECT nome FROM usuarios WHERE role='vendedor' AND ativo=1").all().map(u => u.nome);
  const resolveVend = tag => { if (!tag) return ''; const nt=normS(tag); return vendsDB.find(v => { const nv=normS(v); return nv===nt||nv.includes(nt)||nt.includes(nv); }) || ''; };

  async function fetchDetalhe(id) {
    const b = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id }).toString();
    const r = await fetch('https://api.tiny.com.br/api2/pedido.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
    return r.json();
  }

  try {
    // Step 1: collect pedidos SEM vínculo ecommerce da listagem (loja física)
    // Pedidos de marketplace (ML/Shopee) têm numero_ecommerce preenchido
    const candidatos = []; // itens básicos da lista já filtrados
    while (pagina <= totalPags) {
      const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', dataInicial: toDDMMYYYY(dataInicial), dataFinal: toDDMMYYYY(dataFinal), pagina: String(pagina) }).toString();
      const resp = await fetch('https://api.tiny.com.br/api2/pedidos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const d = await resp.json();
      if (d.retorno?.status !== 'OK') { if (pagina === 1) return res.status(400).json({ erro: d.retorno?.erros?.[0]?.erro || 'Erro na API Tiny.' }); break; }
      totalPags = parseInt(d.retorno?.numero_paginas || '1');
      (Array.isArray(d.retorno?.pedidos) ? d.retorno.pedidos : []).forEach(p => {
        const item = p.pedido || p;
        const numEc = String(item.numero_ecommerce || '').trim();
        if (!numEc) candidatos.push(item); // sem vínculo = loja física
      });
      pagina++;
      if (pagina <= totalPags) await new Promise(r => setTimeout(r, 300));
    }

    // Step 2: busca detalhe apenas dos candidatos (bem menos que o total)
    // para pegar marcadores e detectar vendedora
    const BATCH = 5; // batch menor para respeitar rate limit da Tiny API
    for (let i = 0; i < candidatos.length; i += BATCH) {
      const batch = candidatos.slice(i, i + BATCH);
      const detalhes = await Promise.all(batch.map(item => fetchDetalhe(String(item.id)).catch(() => null)));
      detalhes.forEach((d, idx) => {
        const listItem = batch[idx];
        const ped = d?.retorno?.pedido || d?.retorno?.pedidos?.[0]?.pedido;
        // extrai tags para detectar vendedora (se não conseguir, usa dados da lista)
        let tags = [];
        if (ped) {
          if (Array.isArray(ped.marcadores)) tags = ped.marcadores.map(m => String(m.marcador?.descricao || m.descricao || m).toLowerCase());
          else if (typeof ped.marcadores === 'string' && ped.marcadores) tags = ped.marcadores.split(',').map(s => s.trim().toLowerCase());
        }
        const vendedora = resolveVend(getVendedoraMarcador(tags));
        let data = String(listItem.data_pedido || listItem.data || ped?.data_pedido || '');
        if (data.includes('/')) { const pts = data.split('/'); data = `${pts[2]}-${pts[1]}-${pts[0]}`; }
        const valor = parseFloat(String(listItem.valor || ped?.valor || '0').replace(',', '.')) || 0;
        const tinyId = String(listItem.id || ped?.id || '');
        const numero = String(listItem.numero || ped?.numero || '');
        const cliente = listItem.nome || ped?.nome || '';
        const situacao = listItem.situacao || ped?.situacao || '';
        if (tinyId) { stmt.run(tinyId, numero, cliente, valor, data, vendedora, JSON.stringify(tags), situacao); total++; }
      });
      if (i + BATCH < candidatos.length) await new Promise(r => setTimeout(r, 500));
    }
    // Remove do DB pedidos que não existem mais no Tiny para o período sincronizado
    const tinyIdsAtivos = candidatos.map(c => String(c.id || '')).filter(Boolean);
    if (tinyIdsAtivos.length > 0) {
      const ph = tinyIdsAtivos.map(() => '?').join(',');
      db.prepare(`DELETE FROM tiny_pedidos WHERE data >= ? AND data <= ? AND tiny_id NOT IN (${ph})`).run(dataInicial, dataFinal, ...tinyIdsAtivos);
    } else {
      db.prepare('DELETE FROM tiny_pedidos WHERE data >= ? AND data <= ?').run(dataInicial, dataFinal);
    }
    audit(req, 'SYNC_TINY', 'tiny_pedidos', 0, null, { dataInicial, dataFinal, total });
    res.json({ sucesso: true, total });
  } catch(e) {
    res.status(500).json({ erro: 'Erro de conexão com Tiny: ' + e.message });
  }
});

app.get('/api/tiny/pedidos', auth, (req, res) => {
  const { de, ate } = req.query;
  const rows = (de && ate)
    ? db.prepare('SELECT * FROM tiny_pedidos WHERE data >= ? AND data <= ? ORDER BY data DESC').all(de, ate)
    : db.prepare('SELECT * FROM tiny_pedidos ORDER BY data DESC').all();
  res.json(rows.map(r => ({ ...r, marcadores: JSON.parse(r.marcadores || '[]') })));
});


// ── CATÁLOGO DE MATERIAIS ──
app.get('/api/materiais-catalogo', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM materiais_catalogo WHERE ativo=1 ORDER BY nome COLLATE NOCASE').all());
});
app.post('/api/materiais-catalogo', auth, (req, res) => {
  const { sku, nome, unidade, preco_venda } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório.' });
  const r = db.prepare('INSERT INTO materiais_catalogo (sku,nome,unidade,preco_venda) VALUES (?,?,?,?)').run(sku||null, nome.trim(), unidade||'UN', preco_venda||0);
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/materiais-catalogo/:id', auth, (req, res) => {
  const { sku, nome, unidade, preco_venda, ativo } = req.body;
  if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório.' });
  db.prepare('UPDATE materiais_catalogo SET sku=?,nome=?,unidade=?,preco_venda=?,ativo=? WHERE id=?').run(sku||null, nome.trim(), unidade||'UN', preco_venda||0, ativo===false?0:1, req.params.id);
  res.json({ sucesso: true });
});
app.delete('/api/materiais-catalogo/:id', auth, adminOnly, (req, res) => {
  db.prepare('UPDATE materiais_catalogo SET ativo=0 WHERE id=?').run(req.params.id);
  res.json({ sucesso: true });
});

// Tiny: buscar produtos por nome ou SKU (proxy — evita CORS e mantém token seguro)
app.get('/api/tiny/produtos/buscar', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ itens: [] });
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.json({ itens: [] });
  try {
    const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pesquisa: q, pagina: '1' }).toString();
    const resp = await fetch('https://api.tiny.com.br/api2/produtos.pesquisa.php', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    const data = await resp.json();
    const produtos = Array.isArray(data?.retorno?.produtos) ? data.retorno.produtos : [];
    const itens = produtos.slice(0, 15).map(p => {
      const pr = p.produto || p;
      return {
        id: pr.id,
        sku: pr.codigo || pr.sku || '',
        nome: pr.nome || pr.descricao || '',
        unidade: pr.unidade || 'UN',
        preco: parseFloat(String(pr.preco_venda || pr.preco || '0').replace(',', '.')) || 0,
        preco_custo: parseFloat(String(pr.preco_custo || '0').replace(',', '.')) || 0,
        estoque: pr.saldo_fisico_total != null ? String(pr.saldo_fisico_total) : null
      };
    });
    res.json({ itens });
  } catch(e) {
    res.json({ itens: [] });
  }
});

// Sincronizar catálogo com produtos Tiny (SKU M-)
app.post('/api/tiny/sincronizar-catalogo', auth, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado.' });

  const todos = [];
  let pagina = 1;
  while (pagina <= 30) {
    try {
      const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pesquisa: 'M-', pagina: String(pagina) }).toString();
      const resp = await fetch('https://api.tiny.com.br/api2/produtos.pesquisa.php', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
      });
      const data = await resp.json();
      const produtos = Array.isArray(data?.retorno?.produtos) ? data.retorno.produtos : [];
      if (!produtos.length) break;
      todos.push(...produtos);
      if (produtos.length < 25) break; // página incompleta = última
      pagina++;
    } catch(e) { break; }
  }

  // Apenas SKU que começa com M- (case insensitive)
  const filtrados = todos
    .map(p => p.produto || p)
    .filter(pr => (pr.codigo || '').toUpperCase().startsWith('M-'));

  let inseridos = 0, atualizados = 0;
  filtrados.forEach(pr => {
    const sku        = (pr.codigo || '').trim();
    const nome       = (pr.nome || pr.descricao || '').trim();
    const un         = (pr.unidade || 'UN').trim();
    const preco      = parseFloat(String(pr.preco_venda || pr.preco || '0').replace(',', '.')) || 0;
    const precoCusto = parseFloat(String(pr.preco_custo || '0').replace(',', '.')) || 0;
    if (!nome) return;
    const ex = db.prepare('SELECT id FROM materiais_catalogo WHERE sku=?').get(sku);
    if (ex) {
      db.prepare('UPDATE materiais_catalogo SET nome=?,unidade=?,preco_venda=?,preco_custo=?,ativo=1 WHERE sku=?').run(nome, un, preco, precoCusto, sku);
      atualizados++;
    } else {
      db.prepare('INSERT INTO materiais_catalogo (sku,nome,unidade,preco_venda,preco_custo) VALUES (?,?,?,?,?)').run(sku, nome, un, preco, precoCusto);
      inseridos++;
    }
  });

  console.log(`[SYNC CATÁLOGO] Total Tiny: ${todos.length} | Filtrados M-: ${filtrados.length} | Inseridos: ${inseridos} | Atualizados: ${atualizados}`);
  res.json({ sucesso: true, total: filtrados.length, inseridos, atualizados });
});

// ── ORÇAMENTOS DE MATERIAIS ──
app.get('/api/orcamentos-mat', auth, (req, res) => {
  const orcamentos = db.prepare('SELECT * FROM orcamentos_mat ORDER BY criado_em DESC').all();
  res.json(orcamentos.map(o => ({
    ...o,
    laudo: o.laudo ? (() => { try { return JSON.parse(o.laudo); } catch(e) { return null; } })() : null,
    itens: db.prepare('SELECT * FROM orcamentos_mat_itens WHERE orcamento_id=? ORDER BY ordem').all(o.id)
  })));
});

app.post('/api/orcamentos-mat', auth, (req, res) => {
  const { cliente, visita_id, obs, status, itens, laudo } = req.body;
  if (!cliente || !cliente.trim()) return res.status(400).json({ erro: 'Cliente obrigatório.' });
  const criado_por = req.session.usuario?.nome || null;
  const valor_total = (itens || []).reduce((s, i) => s + (i.preco_total || 0), 0);
  const r = db.prepare('INSERT INTO orcamentos_mat (cliente,visita_id,obs,status,valor_total,criado_por,laudo) VALUES (?,?,?,?,?,?,?)').run(cliente.trim(), visita_id || null, obs || null, status || 'rascunho', valor_total, criado_por, laudo ? JSON.stringify(laudo) : null);
  const id = r.lastInsertRowid;
  const ins = db.prepare('INSERT INTO orcamentos_mat_itens (orcamento_id,sku,nome,unidade,quantidade,preco_unit,preco_total,obs,estoque_tiny,ordem) VALUES (?,?,?,?,?,?,?,?,?,?)');
  (itens || []).forEach((item, idx) => ins.run(id, item.sku || null, item.nome, item.unidade || 'UN', item.quantidade || 1, item.preco_unit || 0, item.preco_total || 0, item.obs || null, item.estoque_tiny || null, idx));
  audit(req, 'CRIAR_ORCAMENTO_MAT', 'orcamentos_mat', id, null, { cliente: cliente.trim() });
  res.json({ sucesso: true, id });
});

app.put('/api/orcamentos-mat/:id', auth, (req, res) => {
  const { cliente, visita_id, obs, status, itens, laudo } = req.body;
  if (!cliente || !cliente.trim()) return res.status(400).json({ erro: 'Cliente obrigatório.' });
  const valor_total = (itens || []).reduce((s, i) => s + (i.preco_total || 0), 0);
  db.prepare("UPDATE orcamentos_mat SET cliente=?,visita_id=?,obs=?,status=?,valor_total=?,laudo=?,atualizado_em=datetime('now','localtime') WHERE id=?").run(cliente.trim(), visita_id || null, obs || null, status || 'rascunho', valor_total, laudo ? JSON.stringify(laudo) : null, req.params.id);
  db.prepare('DELETE FROM orcamentos_mat_itens WHERE orcamento_id=?').run(req.params.id);
  const ins = db.prepare('INSERT INTO orcamentos_mat_itens (orcamento_id,sku,nome,unidade,quantidade,preco_unit,preco_total,obs,estoque_tiny,ordem) VALUES (?,?,?,?,?,?,?,?,?,?)');
  (itens || []).forEach((item, idx) => ins.run(req.params.id, item.sku || null, item.nome, item.unidade || 'UN', item.quantidade || 1, item.preco_unit || 0, item.preco_total || 0, item.obs || null, item.estoque_tiny || null, idx));
  audit(req, 'ATUALIZAR_ORCAMENTO_MAT', 'orcamentos_mat', req.params.id, null, { cliente: cliente.trim(), status });
  res.json({ sucesso: true });
});

app.delete('/api/orcamentos-mat/:id', auth, adminOrTecnico, (req, res) => {
  db.prepare('DELETE FROM orcamentos_mat_itens WHERE orcamento_id=?').run(req.params.id);
  db.prepare('DELETE FROM orcamentos_mat WHERE id=?').run(req.params.id);
  audit(req, 'REMOVER_ORCAMENTO_MAT', 'orcamentos_mat', req.params.id, null, null);
  res.json({ sucesso: true });
});

// ── TRATADOR DE ERROS GLOBAL ──
// Captura "request aborted" (cliente fechou a aba no meio de um upload/save)
// sem deixar o servidor derrubar.
app.use((err, req, res, next) => {
  if (err && (err.type === 'request.aborted' || err.message === 'request aborted' || err.status === 400)) {
    console.warn('[warn] Requisição abortada pelo cliente:', req.method, req.url);
    if (!res.headersSent) res.status(400).end();
    return;
  }
  console.error('[erro]', err);
  if (!res.headersSent) res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ── KOMMO: buscar lead por ID ──
app.get('/api/kommo/lead/:id', auth, async (req, res) => {
  try {
    const { status, body } = await kommoGet(`/leads/${req.params.id}?with=contacts`);
    if (status !== 200) return res.status(status).json({ erro: 'Lead não encontrado no Kommo' });

    const lead = body;
    // Busca o contato principal vinculado ao lead
    let nome = lead.name || '';
    let cel = '';
    const contactLinks = lead._embedded?.contacts || [];
    if (contactLinks.length > 0) {
      try {
        const contId = contactLinks[0].id;
        const cr = await kommoGet(`/contacts/${contId}`);
        if (cr.status === 200) {
          const contact = cr.body;
          if (!nome) nome = contact.name || '';
          const phones = (contact.custom_fields_values || []).find(f => f.field_code === 'PHONE');
          if (phones && phones.values && phones.values.length > 0) {
            cel = phones.values[0].value || '';
          }
        }
      } catch {}
    }
    res.json({ id: lead.id, nome, cel, status_id: lead.status_id, pipeline_id: lead.pipeline_id, valor: lead.price });
  } catch (e) {
    console.error('[Kommo] Erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// Evita que erros não capturados derrubem o processo
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

app.listen(PORT, () => console.log('Capellato rodando na porta', PORT));
