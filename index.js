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

// ── Cor do evento no Google Calendar, por técnico ──
// IDs de cor do Google Calendar: 1 Lavanda · 2 Sálvia · 3 Uva · 4 Flamingo · 5 Banana
// 6 Tangerina · 7 Pavão · 8 Grafite · 9 Mirtilo · 10 Manjericão · 11 Tomate
const GCAL_COR_TECNICO = {
  'joseilto da silva melo': '7',        // Pavão (azul)
  'josé wesley mendes da silva': '10',  // Manjericão (verde)
  'jose wesley mendes da silva': '10',
  'caio molon': '6',                    // Tangerina (laranja)
  'caio': '6',
};
const GCAL_COR_SEM_TECNICO = '8';       // Grafite (cinza) — falta definir quem vai
const GCAL_CORES_EXTRAS = ['3', '5', '11', '9', '4', '2', '1']; // para técnicos novos

function gcalCorPorTecnico(tecnicos) {
  if (!tecnicos || !tecnicos.length) return GCAL_COR_SEM_TECNICO;
  // Com mais de um técnico, usa a cor do primeiro da lista
  const nome = String(tecnicos[0] || '').split('|')[0].trim().toLowerCase();
  if (!nome) return GCAL_COR_SEM_TECNICO;
  if (GCAL_COR_TECNICO[nome]) return GCAL_COR_TECNICO[nome];
  // Técnico não cadastrado: cor estável derivada do nome (o mesmo nome sempre recebe a mesma cor)
  let h = 0;
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) >>> 0;
  return GCAL_CORES_EXTRAS[h % GCAL_CORES_EXTRAS.length];
}

// Monta o objeto de evento Google Calendar a partir de uma visita do banco
function gcalEventFromVisita(v) {
  const tecnicos = (() => { try { return JSON.parse(v.tecnicos || '[]'); } catch { return []; } })();
  const tipoLabel = v.tipo === 'instalacao' ? 'Instalação' : v.tipo === 'retorno' ? 'Retorno' : v.tipo === 'manutencao' ? 'Manutenção' : 'Visita Técnica';
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
  return {
    summary: title,
    description: desc,
    start,
    end,
    location: v.endereco || '',
    colorId: gcalCorPorTecnico(tecnicos),
  };
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

function kommoRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!KOMMO_TOKEN || !KOMMO_SUBDOMAIN) return reject(new Error('Kommo não configurado'));
    const url = `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4${path}`;
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      timeout: 12000, // 12s timeout na conexão
      headers: {
        'Authorization': `Bearer ${KOMMO_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Alery/1.0 (+https://alery-production.up.railway.app)',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(url, opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Timeout ao conectar com Kommo (12s)')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
const kommoGet  = (path)       => kommoRequest('GET',  path, null);
const kommoPost = (path, body) => kommoRequest('POST', path, body);

const app = express();
const PORT = process.env.PORT || 3000;

// ── BANCO DE DADOS ──
const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.NODE_ENV === 'production'
  ? path.join(DATA_DIR, 'capellato.db')
  : 'capellato.db';
const db = new Database(DB_PATH);
const syncJobs = {};
let autoSyncState = { lastRun: null, status: 'idle', total: 0, breakdown: [], erro: null };
let autoSyncRunning = false;

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
// Todas as páginas conhecidas pelo sistema
const ALL_SYSTEM_PAGES = ['dashboard','visita','calendario','proposta','aprovacao','pedidos','instalacao','financeiro','fechamentos','meta','calculadora','sincronizar','auditoria','parametros','usuarios','orcmat','kommo','representacao','comissionamento'];

const DEFAULT_ROLE_PAGES = {
  admin:    [...ALL_SYSTEM_PAGES],
  gerente:  ['dashboard','visita','calendario','proposta','aprovacao','pedidos','instalacao','financeiro','fechamentos','meta','calculadora','sincronizar','auditoria','orcmat','kommo','representacao','comissionamento'],
  vendedor: ['dashboard','visita','calendario','proposta','aprovacao','pedidos','meta','calculadora','sincronizar','orcmat','kommo'],
  tecnico:  ['dashboard','visita','calendario','instalacao','financeiro','calculadora','sincronizar','orcmat'],
  user:     ['dashboard','visita','calendario','proposta','aprovacao','calculadora','sincronizar','comissionamento'],
  representante: ['representacao'],
};

// Páginas obrigatórias para admin (não podem ser removidas)
const ADMIN_LOCKED = new Set(['dashboard','parametros','usuarios','auditoria']);

app.get('/api/role-permissions', auth, (req, res) => {
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave='role_permissions'").get();
    const saved = row ? JSON.parse(row.valor) : {};
    // Respeita exatamente o que foi salvo. Novas páginas NÃO são adicionadas automaticamente.
    // Roles sem config salva usam os defaults.
    const result = {};
    for (const role of Object.keys(DEFAULT_ROLE_PAGES)) {
      if (saved[role]) {
        // Respeita exatamente o que foi salvo — não adiciona novas páginas automaticamente
        result[role] = ALL_SYSTEM_PAGES.filter(p => saved[role].includes(p));
      } else {
        result[role] = [...DEFAULT_ROLE_PAGES[role]];
      }
      // Admin sempre tem as páginas obrigatórias (dashboard, parâmetros, usuários, auditoria)
      if (role === 'admin') {
        for (const p of ADMIN_LOCKED) { if (!result[role].includes(p)) result[role].push(p); }
      }
    }
    res.json(result);
  } catch(e) {
    console.error('[role-permissions GET] Erro:', e.message);
    res.json(DEFAULT_ROLE_PAGES);
  }
});
app.put('/api/role-permissions', auth, adminOnly, (req, res) => {
  try {
    const data = { ...req.body };
    // Garante que páginas obrigatórias do admin sempre estejam presentes
    for (const p of ADMIN_LOCKED) { if (!data.admin) data.admin = []; if (!data.admin.includes(p)) data.admin.push(p); }
    db.prepare("INSERT INTO config (chave,valor) VALUES ('role_permissions',?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor")
      .run(JSON.stringify(data));
    audit(req, 'EDITAR_PERMISSOES', 'config', 0, null, data);
    res.json({ sucesso: true });
  } catch(e) {
    console.error('[role-permissions PUT] Erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
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
app.get('/api/comissao/supervisores', auth, (req, res) => {
  res.json(db.prepare("SELECT nome FROM usuarios WHERE role IN ('admin','gerente') AND ativo=1 ORDER BY nome").all().map(r => r.nome));
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
  const rows = db.prepare('SELECT id,tipo,nome,cel,endereco,cep,data,hora_ini,hora_fim,periodo,obs,tecnicos,vendedora,lead_id,laudo,kommo_task_id,criado_por_id,criado_por_nome,criado_em FROM visitas ORDER BY data ASC, hora_ini ASC, criado_em DESC').all().map(v => ({
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
// Salva o ID da tarefa Kommo na visita (chamado após criar a tarefa)
app.patch('/api/visitas/:id/kommo-task', auth, (req, res) => {
  const { kommo_task_id } = req.body;
  db.prepare('UPDATE visitas SET kommo_task_id=? WHERE id=?').run(kommo_task_id || null, req.params.id);
  res.json({ sucesso: true });
});

app.delete('/api/visitas/:id', auth, async (req, res) => {
  const antes = db.prepare('SELECT nome,data,tipo,google_event_id,kommo_task_id FROM visitas WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM visitas WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_VISITA', 'visitas', req.params.id, antes, null);
  res.json({ sucesso: true });
  // Sync Google Calendar
  if (antes) gcalSync('delete', antes).catch(() => {});
  // Conclui tarefa no Kommo se solicitado (DELETE retorna 403; PATCH com is_completed=true funciona)
  const excluirKommo = req.query.excluir_kommo === 'true';
  const taskId = antes?.kommo_task_id;
  if (excluirKommo && taskId) {
    try {
      const { status, body } = await kommoRequest('PATCH', `/tasks`, [{ id: parseInt(taskId), is_completed: true }]);
      console.log(`[Kommo] Tarefa ${taskId} concluída (status ${status})`);
      if (status !== 200 && status !== 204) {
        console.error('[Kommo] Resposta ao concluir tarefa:', JSON.stringify(body));
      }
    } catch(e) {
      console.error('[Kommo] Erro ao concluir tarefa:', e.message);
    }
  }
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
  const rows = db.prepare('SELECT id,cliente,vendedora,equip,valor,custo,margem,pag,status,texto,custos,motivo_recusa,temperatura_alvo,mat_prop,custo_mat,custo_prod,lead_id,visita_id,orcmat_id,criado_por_id,criado_por_nome,criado_em,aprovado_em,rep_enviado,rep_enviado_em,rep_status,rep_data_visita,rep_obs,rep_tipo FROM aprovacoes ORDER BY criado_em DESC').all();
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
  const criadoEm = d.criado_em ? d.criado_em + ' 00:00:00' : null;
  const repEnviado = d.rep_enviado ? 1 : 0;
  const r = db.prepare("INSERT INTO aprovacoes (cliente,vendedora,equip,valor,custo,margem,pag,status,texto,custos,html_proposta,temperatura_alvo,anexos,mat_prop,custo_mat,custo_prod,visita_id,orcmat_id,lead_id,criado_por_id,criado_por_nome,criado_em,rep_enviado,rep_enviado_em,rep_status,rep_tipo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')),?,IIF(?,datetime('now','localtime'),NULL),IIF(?,'pendente',NULL),IIF(?,'outbound',NULL))")
    .run(d.cliente, d.vendedora, d.equip, d.valor, d.custo, d.margem, d.pag, 'pendente', d.texto, d.custos || null, d.html_proposta || null, d.temperatura_alvo || null, JSON.stringify(d.anexos || []), d.mat_prop || 0, d.custo_mat || 0, d.custo_prod || 0, d.visita_id || null, d.orcmat_id || null, d.lead_id || null, req.session.u.id, req.session.u.nome, criadoEm, repEnviado, repEnviado, repEnviado, repEnviado);
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
  const criadoEmUpd = d.criado_em ? d.criado_em + ' 00:00:00' : null;
  db.prepare('UPDATE aprovacoes SET cliente=?,vendedora=?,equip=?,valor=?,custo=?,margem=?,pag=?,status=?,texto=?,custos=?,html_proposta=COALESCE(?,html_proposta),motivo_recusa=?,temperatura_alvo=?,anexos=COALESCE(?,anexos),mat_prop=?,custo_mat=?,custo_prod=?,visita_id=COALESCE(?,visita_id),orcmat_id=COALESCE(?,orcmat_id),lead_id=COALESCE(?,lead_id),aprovado_em=?,criado_em=COALESCE(?,criado_em) WHERE id=?')
    .run(d.cliente, d.vendedora, d.equip, d.valor, d.custo, d.margem, d.pag, d.status, d.texto, d.custos || null, d.html_proposta || null, d.motivo_recusa || null, d.temperatura_alvo || null, d.anexos ? JSON.stringify(d.anexos) : null, d.mat_prop || 0, d.custo_mat || 0, d.custo_prod || 0, d.visita_id || null, d.orcmat_id || null, d.lead_id || null, aprovadoEm, criadoEmUpd, req.params.id);
  audit(req, 'EDITAR_PROPOSTA', 'aprovacoes', req.params.id, antes, { cliente: d.cliente, valor: d.valor, status: d.status });
  res.json({ sucesso: true });
});
app.patch('/api/aprovacoes/:id/status', auth, (req, res) => {
  try {
    const { status, motivo_recusa } = req.body;
    const antes = db.prepare('SELECT status FROM aprovacoes WHERE id=?').get(req.params.id);
    const aprovadoEm = status === 'aprovado' && antes.status !== 'aprovado' ? "datetime('now','localtime')" : null;
    if (aprovadoEm) {
      db.prepare("UPDATE aprovacoes SET status=?, motivo_recusa=?, aprovado_em=datetime('now','localtime') WHERE id=?").run(status, motivo_recusa||null, req.params.id);
    } else {
      db.prepare('UPDATE aprovacoes SET status=?, motivo_recusa=? WHERE id=?').run(status, motivo_recusa||null, req.params.id);
    }
    audit(req, 'STATUS_PROPOSTA', 'aprovacoes', req.params.id, { status: antes.status }, { status });
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.delete('/api/aprovacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,valor FROM aprovacoes WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM aprovacoes WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_PROPOSTA', 'aprovacoes', req.params.id, antes, null);
  res.json({ sucesso: true });
});

// ── REPRESENTANTE ──
function authRep(req, res, next) {
  if (!req.session.u || !['admin','gerente','representante'].includes(req.session.u.role)) return res.status(403).json({ erro: 'Acesso negado' });
  next();
}
app.post('/api/aprovacoes/:id/enviar-rep', adminOnly, (req, res) => {
  try {
    const tipo = req.body?.tipo === 'outbound' ? 'outbound' : 'inbound';
    db.prepare("UPDATE aprovacoes SET rep_enviado=1, rep_enviado_em=datetime('now','localtime'), rep_status='pendente', rep_tipo=? WHERE id=?").run(tipo, req.params.id);
    audit(req, 'ENVIAR_PARA_REP', 'aprovacoes', req.params.id, null, null);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.delete('/api/aprovacoes/:id/enviar-rep', adminOnly, (req, res) => {
  try {
    db.prepare("UPDATE aprovacoes SET rep_enviado=0, rep_enviado_em=NULL, rep_status=NULL, rep_data_visita=NULL, rep_obs=NULL, rep_tipo=NULL WHERE id=?").run(req.params.id);
    audit(req, 'REMOVER_DA_REP', 'aprovacoes', req.params.id, null, null);
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.get('/api/rep/propostas', authRep, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, a.cliente, a.equip, a.valor, a.pag, a.status, a.temperatura_alvo,
             a.visita_id, a.orcmat_id, a.vendedora, a.criado_em, a.rep_enviado_em,
             a.rep_status, a.rep_data_visita, a.rep_obs, a.lead_id, a.rep_tipo,
             a.custo, a.margem, a.mat_prop, a.custo_mat, a.custo_prod, a.custos, a.motivo_recusa,
             a.texto AS prop_texto, a.anexos AS prop_anexos, a.html_proposta AS prop_html,
             v.endereco, v.cep, v.cel AS vis_cel, v.nome AS vis_nome,
             v.data AS vis_data, v.hora_ini AS vis_hora_ini, v.hora_fim AS vis_hora_fim,
             v.obs AS vis_obs, v.tecnicos AS vis_tecnicos,
             o.valor_total AS orc_valor_total, o.laudo AS orc_laudo, o.obs AS orc_obs,
             (SELECT json_group_array(json_object(
               'nome', i.nome, 'sku', i.sku, 'quantidade', i.quantidade,
               'unidade', i.unidade, 'preco_unit', i.preco_unit, 'preco_total', i.preco_total
             )) FROM orcamentos_mat_itens i WHERE i.orcamento_id = a.orcmat_id ORDER BY i.ordem) AS orc_itens_json
      FROM aprovacoes a
      LEFT JOIN visitas v ON v.id = a.visita_id
      LEFT JOIN orcamentos_mat o ON o.id = a.orcmat_id
      WHERE a.rep_enviado = 1
      ORDER BY a.rep_enviado_em DESC
    `).all();
    res.json(rows.map(r => ({
      ...r,
      orc_laudo:    r.orc_laudo    ? (() => { try { return JSON.parse(r.orc_laudo);    } catch(e) { return null; } })() : null,
      orc_itens:    r.orc_itens_json ? (() => { try { return JSON.parse(r.orc_itens_json); } catch(e) { return []; } })() : [],
      vis_tecnicos: r.vis_tecnicos ? (() => { try { return JSON.parse(r.vis_tecnicos); } catch(e) { return []; } })() : [],
      orc_itens_json: undefined,
    })));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});
app.put('/api/rep/propostas/:id', authRep, (req, res) => {
  try {
    const { rep_status, rep_data_visita, rep_obs } = req.body;
    const antes = db.prepare('SELECT rep_status, rep_data_visita, rep_obs FROM aprovacoes WHERE id=?').get(req.params.id);
    db.prepare('UPDATE aprovacoes SET rep_status=?, rep_data_visita=?, rep_obs=? WHERE id=?')
      .run(rep_status || 'pendente', rep_data_visita || null, rep_obs || null, req.params.id);
    audit(req, 'ATUALIZAR_REP', 'aprovacoes', req.params.id, antes, { rep_status, rep_data_visita, rep_obs });
    res.json({ sucesso: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
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
try { db.prepare('ALTER TABLE visitas ADD COLUMN kommo_task_id TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN rep_enviado INTEGER DEFAULT 0').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN rep_enviado_em TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN rep_status TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN rep_data_visita TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN rep_obs TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE aprovacoes ADD COLUMN rep_tipo TEXT DEFAULT NULL').run(); } catch(e) {}

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
app.put('/api/aprovacoes/:id/visita', auth, (req, res) => {
  const val = req.body.visita_id !== undefined ? req.body.visita_id : null;
  db.prepare('UPDATE aprovacoes SET visita_id=? WHERE id=?').run(val, req.params.id);
  audit(req, val ? 'VINCULAR_VISITA' : 'DESVINCULAR_VISITA', 'aprovacoes', req.params.id, null, { visita_id: val });
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
try { db.prepare('ALTER TABLE tiny_pedidos ADD COLUMN itens TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE tiny_pedidos ADD COLUMN telefone TEXT DEFAULT NULL').run(); } catch(e) {}
try { db.prepare('ALTER TABLE tiny_pedidos ADD COLUMN tem_capa INTEGER DEFAULT 0').run(); } catch(e) {}

// ── Identificação de produtos de capa térmica ──
// Regra por nome: produtos cadastrados no Tiny têm "Capa Térmica" no título. A comparação
// ignora acentos e maiúsculas, e também aceita as duas palavras separadas ("Capa de Piscina
// Térmica"). Cobre cadastros futuros sem precisar manter lista de SKU.
// Se algum produto fugir do padrão de nome, basta incluir o SKU em CAPA_SKUS.
const CAPA_SKUS = []; // ex.: ['CAPA500', 'GEOCOVER12']
function _normTxt(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function itemEhCapa(descricao, sku) {
  if (sku && CAPA_SKUS.includes(String(sku).trim().toUpperCase())) return true;
  const t = _normTxt(descricao);
  // Acessórios que citam "capa térmica" no nome mas não são a capa em si
  if (/enrolador|carretel|suporte|reparo|emenda/.test(t)) return false;
  return t.includes('capa termica') || (t.includes('capa') && t.includes('termic'));
}
// Telefone comparável. Os últimos 8 dígitos são estáveis mesmo com DDI e com o "9" extra
// do celular (que entra à frente do número), então servem de chave. O DDD, quando existe
// nos dois lados, é usado para desempatar e evitar casar clientes de estados diferentes.
function telPartes(tel) {
  const d = String(tel || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length < 8) return null;
  return { base: d.slice(-8), ddd: d.length >= 10 ? d.slice(0, 2) : '' };
}
function telKey(tel) {
  const p = telPartes(tel);
  return p ? p.base : '';
}
function telCombina(a, b) {
  const pa = telPartes(a), pb = telPartes(b);
  if (!pa || !pb || pa.base !== pb.base) return false;
  if (pa.ddd && pb.ddd && pa.ddd !== pb.ddd) return false; // mesmo final, estados diferentes
  return true;
}
// Extrai itens e telefone do detalhe de um pedido da API Tiny
function extrairDetalhePedido(ped) {
  if (!ped) return { itens: [], telefone: '', temCapa: 0 };
  const brutos = Array.isArray(ped.itens) ? ped.itens : [];
  const itens = brutos.map(x => {
    const it = x.item || x;
    return {
      sku: String(it.codigo || '').trim(),
      descricao: String(it.descricao || '').trim(),
      qtd: parseFloat(String(it.quantidade || '0').replace(',', '.')) || 0,
      valor: parseFloat(String(it.valor_unitario || it.valor || '0').replace(',', '.')) || 0,
    };
  }).filter(i => i.descricao || i.sku);
  const cli = ped.cliente || {};
  const telefone = String(cli.fone || cli.celular || ped.fone || '').trim();
  const temCapa = itens.some(i => itemEhCapa(i.descricao, i.sku)) ? 1 : 0;
  return { itens, telefone, temCapa };
}

function detectarVendedoraTiny(tags) {
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const excluir = ['loja fisica', 'loja f', '1a venda', '1 venda'];
  return tags.find(t => !excluir.some(e => norm(t).includes(e))) || '';
}

// Sincroniza os pedidos de loja física do período.
// Extraído do endpoint para poder rodar também no sync automático.
async function doSyncLojaFisica(dataInicial, dataFinal, tokenValorLF) {
  const tokenRow = { valor: tokenValorLF };
  const toDDMMYYYY = s => s.split('-').reverse().join('/');
  const stmt = db.prepare(`INSERT INTO tiny_pedidos (tiny_id,numero,cliente,valor,data,vendedora,marcadores,situacao,itens,telefone,tem_capa)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tiny_id) DO UPDATE SET
    numero=excluded.numero, cliente=excluded.cliente, valor=excluded.valor, data=excluded.data,
    situacao=excluded.situacao, marcadores=excluded.marcadores,
    itens=COALESCE(excluded.itens, tiny_pedidos.itens),
    telefone=COALESCE(NULLIF(excluded.telefone,''), tiny_pedidos.telefone),
    -- Só reavalia a marcação de capa quando o detalhe do pedido veio nesta sincronização.
    -- Se a API falhou (itens nulos), preserva o que já estava salvo em vez de zerar.
    tem_capa=CASE WHEN excluded.itens IS NOT NULL THEN excluded.tem_capa ELSE tiny_pedidos.tem_capa END,
    vendedora=CASE WHEN tiny_pedidos.vendedora IS NULL OR tiny_pedidos.vendedora='' THEN excluded.vendedora ELSE tiny_pedidos.vendedora END,
    sincronizado_em=datetime('now','localtime')`);
  let total = 0, pagina = 1, totalPags = 1;
  const ignorados = [];      // sem o marcador de loja física — não entram no faturamento
  const indeterminados = []; // detalhe não retornou: preserva o que já existe no banco
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

  // O telefone não vem no pedido nem na pesquisa de contatos — só no detalhe do contato,
  // e normalmente no campo "celular". São duas chamadas, feitas apenas para pedidos de capa
  // que estejam sem telefone, para não pesar a sincronização.
  async function fetchTelefoneContato(cpfCnpj, nome) {
    // O nome encontra de forma mais confiável que o CPF (o Tiny guarda o CPF formatado),
    // então tenta nome, CPF como está e CPF só com dígitos.
    const termos = [
      String(nome || '').trim(),
      String(cpfCnpj || '').trim(),
      String(cpfCnpj || '').replace(/\D/g, ''),
    ].filter((t, i, arr) => t && arr.indexOf(t) === i);
    for (const termo of termos) {
      try {
        const b = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pesquisa: termo }).toString();
        const r = await fetch('https://api.tiny.com.br/api2/contatos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
        const d = await r.json();
        const lista = Array.isArray(d?.retorno?.contatos) ? d.retorno.contatos : [];
        for (const c of lista.slice(0, 2)) {
          const ct = c.contato || c;
          const jaTem = String(ct.celular || ct.fone || '').trim();
          if (jaTem) return jaTem;
          if (!ct.id) continue;
          // O telefone só aparece no detalhe do contato, normalmente no campo "celular"
          const b2 = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id: String(ct.id) }).toString();
          const r2 = await fetch('https://api.tiny.com.br/api2/contato.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b2 });
          const d2 = await r2.json();
          const det = d2?.retorno?.contato;
          const tel = String(det?.celular || det?.fone || '').trim();
          if (tel) return tel;
        }
      } catch (e) { console.warn('[Tiny] busca de telefone falhou:', e.message); }
    }
    return '';
  }

  try {
    // Step 1: collect pedidos SEM vínculo ecommerce da listagem (loja física)
    // Pedidos de marketplace (ML/Shopee) têm numero_ecommerce preenchido
    const candidatos = []; // itens básicos da lista já filtrados
    while (pagina <= totalPags) {
      const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', dataInicial: toDDMMYYYY(dataInicial), dataFinal: toDDMMYYYY(dataFinal), pagina: String(pagina) }).toString();
      const resp = await fetch('https://api.tiny.com.br/api2/pedidos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const d = await resp.json();
      if (d.retorno?.status !== 'OK') {
        if (pagina === 1) throw new Error(d.retorno?.erros?.[0]?.erro || 'Erro na API Tiny.');
        break;
      }
      totalPags = parseInt(d.retorno?.numero_paginas || '1');
      (Array.isArray(d.retorno?.pedidos) ? d.retorno.pedidos : []).forEach(p => {
        const item = p.pedido || p;
        const numEc = String(item.numero_ecommerce || '').trim();
        if (!numEc) candidatos.push(item); // sem vínculo = loja física
      });
      pagina++;
      if (pagina <= totalPags) await new Promise(r => setTimeout(r, 300));
    }

    // Step 2: busca detalhe dos candidatos para ler marcadores e vendedora.
    // O detalhe é uma chamada por pedido e o Tiny limita a taxa: com o mês inteiro
    // de candidatos, o limite estourava no meio e os últimos pedidos — justamente
    // os mais novos — voltavam sem detalhe e não entravam. Por isso só busca
    // detalhe de quem é novo ou mudou de valor/situação desde a última sync.
    const jaNoBanco = new Map(
      db.prepare('SELECT tiny_id, valor, situacao, marcadores FROM tiny_pedidos WHERE data >= ? AND data <= ?')
        .all(dataInicial, dataFinal)
        .map(r => [String(r.tiny_id), r])
    );
    const inalterado = (item) => {
      const r = jaNoBanco.get(String(item.id || ''));
      if (!r) return false;
      let tagsSalvas = [];
      try { tagsSalvas = JSON.parse(r.marcadores || '[]'); } catch (e) { return false; }
      if (!isLojaFisica(tagsSalvas)) return false; // precisa reconfirmar pela API
      const vNovo = parseFloat(String(item.valor || '0').replace(',', '.')) || 0;
      const vAntigo = parseFloat(r.valor) || 0;
      if (Math.abs(vNovo - vAntigo) > 0.009) return false;
      return String(item.situacao || '') === String(r.situacao || '');
    };
    const jaOk = candidatos.filter(inalterado);
    // Mais novos primeiro: se o limite da API estourar, quem fica de fora são os
    // pedidos antigos (já conhecidos), não a venda que acabou de ser lançada.
    const paraDetalhar = candidatos
      .filter(c => !inalterado(c))
      .sort((a, b) => (parseInt(b.id) || 0) - (parseInt(a.id) || 0));
    total += jaOk.length;

    const BATCH = 5; // batch menor para respeitar rate limit da Tiny API
    for (let i = 0; i < paraDetalhar.length; i += BATCH) {
      const batch = paraDetalhar.slice(i, i + BATCH);
      // Três tentativas com pausa crescente: o limite da API do Tiny é a causa mais
      // comum de falha, e sem o detalhe não dá para ler o marcador de loja física.
      const buscarComRetry = async (id) => {
        for (let tentativa = 0; tentativa < 3; tentativa++) {
          if (tentativa > 0) await new Promise(s => setTimeout(s, 1200 * tentativa));
          const r = await fetchDetalhe(id).catch(() => null);
          if (r?.retorno?.pedido || r?.retorno?.pedidos?.[0]?.pedido) return r;
        }
        return null;
      };
      const detalhes = await Promise.all(batch.map(item => buscarComRetry(String(item.id))));
      // Pedidos de capa sem telefone: busca no cadastro do contato.
      // Em série e com pausa, porque são 2 chamadas por contato e o Tiny limita a taxa.
      const telsExtras = [];
      for (const d of detalhes) {
        const ped = d?.retorno?.pedido || d?.retorno?.pedidos?.[0]?.pedido;
        const det = extrairDetalhePedido(ped);
        if (!det.temCapa || det.telefone) { telsExtras.push(''); continue; }
        const cli = ped?.cliente || {};
        const tel = await fetchTelefoneContato(cli.cpf_cnpj, cli.nome || ped?.nome).catch(() => '');
        telsExtras.push(tel);
        await new Promise(r => setTimeout(r, 400));
      }
      detalhes.forEach((d, idx) => {
        const listItem = batch[idx];
        const ped = d?.retorno?.pedido || d?.retorno?.pedidos?.[0]?.pedido;
        // extrai tags para detectar vendedora (se não conseguir, usa dados da lista)
        let tags = [];
        if (ped) {
          if (Array.isArray(ped.marcadores)) tags = ped.marcadores.map(m => String(m.marcador?.descricao || m.descricao || m).toLowerCase());
          else if (typeof ped.marcadores === 'string' && ped.marcadores) tags = ped.marcadores.split(',').map(s => s.trim().toLowerCase());
        }
        // Só é loja física quando o pedido tem o marcador correspondente no Tiny.
        // Sem essa checagem entravam vendas de distribuidor, multiempresa etc.
        // Se o detalhe não veio (falha/limite da API), não dá para saber: o pedido fica
        // como indeterminado e é preservado, em vez de sumir silenciosamente.
        if (!ped) { indeterminados.push(String(listItem.id || '')); return; }
        if (!isLojaFisica(tags)) { ignorados.push(String(listItem.id || ped?.id || '')); return; }
        const vendedora = resolveVend(getVendedoraMarcador(tags));
        let data = String(listItem.data_pedido || listItem.data || ped?.data_pedido || '');
        if (data.includes('/')) { const pts = data.split('/'); data = `${pts[2]}-${pts[1]}-${pts[0]}`; }
        const valor = parseFloat(String(listItem.valor || ped?.valor || '0').replace(',', '.')) || 0;
        const tinyId = String(listItem.id || ped?.id || '');
        const numero = String(listItem.numero || ped?.numero || '');
        const cliente = listItem.nome || ped?.nome || '';
        const situacao = listItem.situacao || ped?.situacao || '';
        const det = extrairDetalhePedido(ped);
        const telefone = det.telefone || telsExtras[idx] || '';
        if (tinyId) {
          stmt.run(tinyId, numero, cliente, valor, data, vendedora, JSON.stringify(tags), situacao,
            det.itens.length ? JSON.stringify(det.itens) : null, telefone || null, det.temCapa);
          total++;
        }
      });
      if (i + BATCH < paraDetalhar.length) await new Promise(r => setTimeout(r, 500));
    }
    // Limpa o período: saem os que não existem mais no Tiny e os que perderam
    // (ou nunca tiveram) o marcador de loja física.
    const ignoradosSet = new Set(ignorados.filter(Boolean));
    const indefSet = new Set(indeterminados.filter(Boolean));
    // Mantém no período: os confirmados como loja física + os indeterminados
    // (esses últimos só saem quando a API confirmar que não têm o marcador).
    const tinyIdsAtivos = candidatos
      .map(c => String(c.id || ''))
      .filter(id => id && !ignoradosSet.has(id));
    if (tinyIdsAtivos.length > 0) {
      const ph = tinyIdsAtivos.map(() => '?').join(',');
      db.prepare(`DELETE FROM tiny_pedidos WHERE data >= ? AND data <= ? AND tiny_id NOT IN (${ph})`).run(dataInicial, dataFinal, ...tinyIdsAtivos);
    } else {
      db.prepare('DELETE FROM tiny_pedidos WHERE data >= ? AND data <= ?').run(dataInicial, dataFinal);
    }
    if (indefSet.size) console.warn(`[SyncLF] ${indefSet.size} pedido(s) sem detalhe da API — preservados como indeterminados`);
    return { total, ignorados_sem_marcador: ignoradosSet.size, indeterminados: indefSet.size };
  } catch(e) {
    throw new Error('Erro de conexão com Tiny: ' + e.message);
  }
}

app.post('/api/tiny/sincronizar', auth, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado.' });
  const { dataInicial, dataFinal } = req.body;
  if (!dataInicial || !dataFinal) return res.status(400).json({ erro: 'Informe o período.' });
  try {
    const r = await doSyncLojaFisica(dataInicial, dataFinal, tokenRow.valor);
    audit(req, 'SYNC_TINY', 'tiny_pedidos', 0, null, { dataInicial, dataFinal, total: r.total });
    // indeterminados = a API não devolveu o detalhe. Precisa aparecer: antes o
    // retorno só dizia "✓ N sincronizados" e a falha passava despercebida.
    res.json({ sucesso: true, total: r.total, indeterminados: r.indeterminados, ignorados: r.ignorados_sem_marcador });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/tiny/pedidos', auth, (req, res) => {
  const { de, ate } = req.query;
  const rows = (de && ate)
    ? db.prepare('SELECT * FROM tiny_pedidos WHERE data >= ? AND data <= ? ORDER BY data DESC').all(de, ate)
    : db.prepare('SELECT * FROM tiny_pedidos ORDER BY data DESC').all();
  res.json(rows.map(r => ({ ...r, marcadores: JSON.parse(r.marcadores || '[]') })));
});


// ── COMISSIONAMENTO / MARKETPLACE ──
db.exec(`
  CREATE TABLE IF NOT EXISTS ecommerce_pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tiny_id TEXT UNIQUE NOT NULL,
    numero TEXT,
    numero_ecommerce TEXT,
    canal TEXT DEFAULT 'mercado_livre',
    cliente TEXT,
    valor REAL DEFAULT 0,
    data TEXT,
    vendedora TEXT,
    situacao TEXT,
    sincronizado_em TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS comissao_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendedora TEXT NOT NULL,
    canal TEXT NOT NULL,
    percentual REAL DEFAULT 0,
    UNIQUE(vendedora, canal)
  );
  CREATE TABLE IF NOT EXISTS comissao_metas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    mes TEXT NOT NULL,
    valor REAL DEFAULT 0,
    UNIQUE(tipo, mes)
  );
`);

app.get('/api/sync-status/:jobId', auth, (req, res) => {
  const job = syncJobs[req.params.jobId];
  if (!job) return res.status(404).json({ erro: 'Job não encontrado.' });
  res.json(job);
});

async function doSyncMarketplace(dataInicial, dataFinal, tokenValor, onProgress) {
  const toDDMMYYYY = s => s.split('-').reverse().join('/');
  const normSL = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let mlFullIds = new Set(), shopeeIds = new Set();
  let debugLojas = { raw: null, mlFullIds: [], shopeeIds: [] };
  try {
    const esb = new URLSearchParams({ token: tokenValor, formato: 'JSON' }).toString();
    const esr = await fetch('https://api.tiny.com.br/api2/ecommerce.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: esb });
    const esd = await esr.json();
    debugLojas.raw = JSON.stringify(esd).slice(0, 3000);
    const lojas = esd?.retorno?.ecommerces || esd?.retorno?.lojas || [];
    (Array.isArray(lojas) ? lojas : []).forEach(l => {
      const loja = l.loja || l.ecommerce || l;
      const nome = normSL(String(loja.nome || loja.descricao || loja.nomeEcommerce || ''));
      const id = String(loja.id || '');
      if (id) {
        if (nome.includes('fulfillment') || nome.includes('fulfilment') || nome.includes('livre full')) { mlFullIds.add(id); debugLojas.mlFullIds.push({ id, nome }); }
        else if (nome.includes('shopee')) { shopeeIds.add(id); debugLojas.shopeeIds.push({ id, nome }); }
      }
    });
  } catch(e) { debugLojas.raw = 'ERRO: ' + e.message; }
  const ML_FULL_EC_IDS = new Set(['8505']);
  const SHOPEE_EC_IDS  = new Set(['6063']);
  const detectCanal = (numEc, tags, ec, formaEnvio, nomeEc, ecId) => {
    const feN = normSL(formaEnvio || '').replace(/[\s_-]/g, '');
    const ne = nomeEc || '';
    if (/[a-z]/i.test(numEc) || feN.includes('shopee') || ne.includes('shopee') || SHOPEE_EC_IDS.has(ecId) || shopeeIds.has(ecId)) return 'shopee';
    if (ML_FULL_EC_IDS.has(ecId) || mlFullIds.has(ecId) || ne.includes('fulfillment') || ne.includes('fulfilment') || ne.includes('livre full') ||
        tags.some(t => normSL(t).includes('fulfillment') || normSL(t).includes('fulfilment') || normSL(t) === 'full')) return 'mercado_livre_fulfillment';
    return 'mercado_livre';
  };
  const stmt = db.prepare(`INSERT INTO ecommerce_pedidos (tiny_id,numero,numero_ecommerce,canal,cliente,valor,data,vendedora,situacao)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tiny_id) DO UPDATE SET
    numero=excluded.numero, cliente=excluded.cliente, valor=excluded.valor, data=excluded.data,
    situacao=excluded.situacao, numero_ecommerce=excluded.numero_ecommerce,
    canal=excluded.canal,
    sincronizado_em=datetime('now','localtime')`);
  const candidatos = [];
  let pagina = 1, totalPags = 1;
  while (pagina <= totalPags) {
    const body = new URLSearchParams({ token: tokenValor, formato: 'JSON', dataInicial: toDDMMYYYY(dataInicial), dataFinal: toDDMMYYYY(dataFinal), pagina: String(pagina) }).toString();
    const resp = await fetch('https://api.tiny.com.br/api2/pedidos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const d = await resp.json();
    if (d.retorno?.status !== 'OK') { if (pagina === 1) throw new Error(d.retorno?.erros?.[0]?.erro || 'Erro na API Tiny.'); break; }
    totalPags = parseInt(d.retorno?.numero_paginas || '1');
    (Array.isArray(d.retorno?.pedidos) ? d.retorno.pedidos : []).forEach(p => {
      const item = p.pedido || p;
      const numEc = String(item.numero_ecommerce || '').trim();
      if (numEc) candidatos.push({ ...item, numEc, ecommerce: String(item.ecommerce || '') });
    });
    pagina++;
    if (pagina <= totalPags) await new Promise(r => setTimeout(r, 300));
  }
  let total = 0, nullPedCount = 0;
  const ecIdContagem = {};
  const debugAmostras = [];
  const debugNullPeds = [];
  const fetchDetalhe = async (id) => {
    const b = new URLSearchParams({ token: tokenValor, formato: 'JSON', id: String(id) }).toString();
    let lastErr = '';
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      try {
        const r = await fetch('https://api.tiny.com.br/api2/pedido.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
        const d = await r.json();
        if (d?.retorno?.pedido) return { ped: d, err: null };
        lastErr = JSON.stringify(d?.retorno || d).slice(0, 300);
        if (tentativa < 3) {
          const isRateLimit = d?.retorno?.codigo_erro === 6 || String(d?.retorno?.erros?.[0]?.erro || '').includes('Bloqueada');
          await new Promise(r => setTimeout(r, isRateLimit ? 15000 : 2000));
        }
      } catch(e) { lastErr = 'CATCH:' + e.message; if (tentativa < 3) await new Promise(r => setTimeout(r, 2000)); }
    }
    return { ped: null, err: lastErr };
  };
  for (let i = 0; i < candidatos.length; i++) {
    if (onProgress) onProgress(i + 1, candidatos.length);
    const listItem = candidatos[i];
    const { ped: dResult, err: dErr } = await fetchDetalhe(listItem.id);
    const ped = dResult?.retorno?.pedido;
    if (!ped) { nullPedCount++; if (debugNullPeds.length < 5) debugNullPeds.push({ id: listItem.id, numEc: listItem.numEc, err: dErr }); }
    let tags = [];
    if (ped) {
      if (Array.isArray(ped.marcadores)) tags = ped.marcadores.map(m => String(m.marcador?.descricao || m.descricao || m).toLowerCase());
      else if (typeof ped.marcadores === 'string' && ped.marcadores) tags = ped.marcadores.split(',').map(s => s.trim().toLowerCase());
    }
    const pedEcArr = Array.isArray(ped?.ecommerce) ? ped.ecommerce : (ped?.ecommerce ? [ped.ecommerce] : []);
    const nomeEc = pedEcArr.map(e => normSL(typeof e === 'object' && e ? (e.nomeEcommerce || '') : '')).join(' ');
    const ecId = pedEcArr.map(e => typeof e === 'object' && e ? String(e.id || '') : '').filter(Boolean).join(' ');
    const canal = detectCanal(listItem.numEc, tags, listItem.ecommerce, ped?.forma_envio, nomeEc, ecId);
    const ecIdKey = ecId || (ped ? 'sem_ecid' : 'null_ped');
    ecIdContagem[ecIdKey] = (ecIdContagem[ecIdKey] || 0) + 1;
    if (debugAmostras.length < 15) debugAmostras.push({ numEc: listItem.numEc, nomeEc, ecId, formaEnvio: ped?.forma_envio, tags, canal });
    let data = String(listItem.data_pedido || listItem.data || ped?.data_pedido || '');
    if (data.includes('/')) { const pts = data.split('/'); data = `${pts[2]}-${pts[1]}-${pts[0]}`; }
    const valor = parseFloat(String(listItem.valor || ped?.valor || '0').replace(',', '.')) || 0;
    const tinyId = String(listItem.id || '');
    if (tinyId) { stmt.run(tinyId, String(listItem.numero || ped?.numero || ''), listItem.numEc, canal, listItem.nome || ped?.nome || '', valor, data, '', listItem.situacao || ped?.situacao || ''); total++; }
    await new Promise(r => setTimeout(r, 700));
  }
  const tinyIdsAtivos = candidatos.map(c => String(c.id || '')).filter(Boolean);
  if (tinyIdsAtivos.length > 0) {
    const ph = tinyIdsAtivos.map(() => '?').join(',');
    db.prepare(`DELETE FROM ecommerce_pedidos WHERE data >= ? AND data <= ? AND tiny_id NOT IN (${ph})`).run(dataInicial, dataFinal, ...tinyIdsAtivos);
  } else {
    db.prepare('DELETE FROM ecommerce_pedidos WHERE data >= ? AND data <= ?').run(dataInicial, dataFinal);
  }
  const breakdown = db.prepare(`SELECT canal, COUNT(*) as cnt FROM ecommerce_pedidos WHERE data >= ? AND data <= ? GROUP BY canal`).all(dataInicial, dataFinal);
  return { total, breakdown, nullPedCount, ecIdContagem, debug: debugAmostras, debugNullPeds, debugLojas };
}

app.post('/api/tiny/sincronizar-marketplace', auth, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado.' });
  const { dataInicial, dataFinal } = req.body;
  if (!dataInicial || !dataFinal) return res.status(400).json({ erro: 'Informe o período.' });
  const jobId = Date.now().toString();
  syncJobs[jobId] = { status: 'running', progresso: 0, total: 0 };
  res.json({ jobId });
  (async () => {
    try {
      const result = await doSyncMarketplace(dataInicial, dataFinal, tokenRow.valor, (progresso, total) => {
        syncJobs[jobId].progresso = progresso;
        syncJobs[jobId].total = total;
      });
      audit(req, 'SYNC_MARKETPLACE', 'ecommerce_pedidos', 0, null, { dataInicial, dataFinal, total: result.total });
      syncJobs[jobId] = { status: 'done', sucesso: true, ...result };
    } catch(e) { syncJobs[jobId] = { status: 'error', erro: 'Erro: ' + e.message }; }
  })();
});

async function runAutoSyncMarketplace() {
  if (autoSyncRunning) { console.log('[AutoSync] Já rodando, pulando.'); return; }
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) { console.log('[AutoSync] Token Tiny não configurado.'); return; }
  autoSyncRunning = true;
  const startTime = new Date().toISOString();
  autoSyncState = { lastRun: startTime, status: 'running', total: 0, breakdown: [], erro: null };
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const dataInicial = `${y}-${String(m+1).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m+1, 0).getDate();
  const dataFinal = `${y}-${String(m+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  console.log(`[AutoSync] Iniciando ${dataInicial} → ${dataFinal}`);
  try {
    const result = await doSyncMarketplace(dataInicial, dataFinal, tokenRow.valor, null);
    // Loja física também entra no automático: antes só era sincronizada manualmente,
    // e por isso pedidos recentes ficavam de fora do faturamento e das comissões.
    let totalLF = 0;
    try {
      const lf = await doSyncLojaFisica(dataInicial, dataFinal, tokenRow.valor);
      totalLF = lf.total || 0;
      console.log(`[AutoSync] Loja física: ${totalLF} pedidos`);
    } catch(eLF) {
      console.error('[AutoSync] Falha na loja física:', eLF.message);
    }
    autoSyncState = {
      lastRun: startTime, status: 'done', total: result.total + totalLF,
      breakdown: [...result.breakdown, { canal: 'loja_fisica', total: totalLF }], erro: null,
    };
    db.prepare("INSERT OR REPLACE INTO config(chave,valor) VALUES('auto_sync_last',?)").run(new Date().toISOString());
    console.log(`[AutoSync] Concluído: ${result.total} marketplace + ${totalLF} loja física`);
  } catch(e) {
    autoSyncState = { lastRun: startTime, status: 'error', total: 0, breakdown: [], erro: e.message };
    console.error('[AutoSync] Erro:', e.message);
  } finally { autoSyncRunning = false; }
}

async function runCancelStatusCheck() {
  if (autoSyncRunning) return;
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return;
  try {
    const toDDMMYYYY = s => s.split('-').reverse().join('/');
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const dataInicial = `${y}-${String(m+1).padStart(2,'0')}-01`;
    const lastDay = new Date(y, m+1, 0).getDate();
    const dataFinal = `${y}-${String(m+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const tinyOrders = new Map();
    let pagina = 1, totalPags = 1;
    while (pagina <= totalPags) {
      const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', dataInicial: toDDMMYYYY(dataInicial), dataFinal: toDDMMYYYY(dataFinal), pagina: String(pagina) }).toString();
      const resp = await fetch('https://api.tiny.com.br/api2/pedidos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const d = await resp.json();
      if (d.retorno?.status !== 'OK') break;
      totalPags = parseInt(d.retorno?.numero_paginas || '1');
      (Array.isArray(d.retorno?.pedidos) ? d.retorno.pedidos : []).forEach(p => {
        const item = p.pedido || p;
        if (item.id) tinyOrders.set(String(item.id), item.situacao || '');
      });
      pagina++;
      if (pagina <= totalPags) await new Promise(r => setTimeout(r, 300));
    }
    const dbOrders = db.prepare('SELECT tiny_id, situacao FROM ecommerce_pedidos WHERE data >= ? AND data <= ?').all(dataInicial, dataFinal);
    const updateStmt = db.prepare("UPDATE ecommerce_pedidos SET situacao=?, sincronizado_em=datetime('now','localtime') WHERE tiny_id=?");
    let updated = 0;
    dbOrders.forEach(row => {
      const tinySit = tinyOrders.get(row.tiny_id);
      if (tinySit !== undefined && tinySit !== row.situacao) { updateStmt.run(tinySit, row.tiny_id); updated++; }
    });
    if (updated > 0) console.log(`[CancelCheck] Atualizadas ${updated} situações`);
  } catch(e) { console.error('[CancelCheck] Erro:', e.message); }
}

app.get('/api/tiny/auto-sync-status', auth, (req, res) => {
  const lastStored = db.prepare("SELECT valor FROM config WHERE chave='auto_sync_last'").get();
  res.json({ ...autoSyncState, lastStoredRun: lastStored?.valor || null });
});

app.get('/api/ecommerce/pedidos', auth, (req, res) => {
  const { de, ate } = req.query;
  const rows = (de && ate)
    ? db.prepare('SELECT * FROM ecommerce_pedidos WHERE data >= ? AND data <= ? ORDER BY data DESC').all(de, ate)
    : db.prepare('SELECT * FROM ecommerce_pedidos ORDER BY data DESC').all();
  res.json(rows);
});
app.put('/api/ecommerce/pedidos/:id/canal', auth, (req, res) => {
  db.prepare('UPDATE ecommerce_pedidos SET canal=? WHERE id=?').run(req.body.canal || 'mercado_livre', req.params.id);
  res.json({ sucesso: true });
});
app.put('/api/ecommerce/pedidos/:id/vendedora', auth, (req, res) => {
  db.prepare('UPDATE ecommerce_pedidos SET vendedora=? WHERE id=?').run(req.body.vendedora || null, req.params.id);
  res.json({ sucesso: true });
});
app.delete('/api/ecommerce/pedidos/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM ecommerce_pedidos WHERE id=?').run(req.params.id);
  audit(req, 'REMOVER_PEDIDO_ECOMM', 'ecommerce_pedidos', req.params.id, null, null);
  res.json({ sucesso: true });
});
app.get('/api/comissao/config', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM comissao_config').all());
});
app.put('/api/comissao/config', auth, async (req, res) => {
  const { vendedora, canal, percentual } = req.body;
  if (!vendedora || !canal) return res.status(400).json({ erro: 'vendedora e canal obrigatórios.' });
  db.prepare('INSERT INTO comissao_config (vendedora,canal,percentual) VALUES (?,?,?) ON CONFLICT(vendedora,canal) DO UPDATE SET percentual=excluded.percentual')
    .run(vendedora, canal, parseFloat(percentual) || 0);
  audit(req, 'ATUALIZAR_COMISSAO', 'comissao_config', 0, null, { vendedora, canal, percentual });
  res.json({ sucesso: true });
});

app.get('/api/comissao/metas', auth, (req, res) => {
  const { mes } = req.query;
  const rows = mes
    ? db.prepare('SELECT * FROM comissao_metas WHERE mes = ?').all(mes)
    : db.prepare('SELECT * FROM comissao_metas ORDER BY mes DESC').all();
  res.json(rows);
});
app.put('/api/comissao/metas', auth, (req, res) => {
  const { tipo, mes, valor } = req.body;
  if (!tipo || !mes) return res.status(400).json({ erro: 'tipo e mes obrigatórios.' });
  db.prepare('INSERT INTO comissao_metas (tipo, mes, valor) VALUES (?,?,?) ON CONFLICT(tipo, mes) DO UPDATE SET valor=excluded.valor')
    .run(tipo, mes, parseFloat(valor) || 0);
  res.json({ sucesso: true });
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

app.delete('/api/orcamentos-mat/:id', auth, (req, res) => {
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

// ── KOMMO: diagnóstico (sem expor o token) ──
app.get('/api/kommo/status', auth, (req, res) => {
  res.json({
    token_configurado: !!KOMMO_TOKEN,
    token_tamanho: KOMMO_TOKEN.length,
    subdomain: KOMMO_SUBDOMAIN || '(vazio)'
  });
});

// ── KOMMO: buscar lead por ID ──
app.get('/api/kommo/lead/:id', auth, async (req, res) => {
  try {
    if (!KOMMO_TOKEN || !KOMMO_SUBDOMAIN) {
      return res.status(503).json({ erro: 'Kommo não configurado no servidor (variáveis ausentes)' });
    }
    const { status, body } = await kommoGet(`/leads/${req.params.id}?with=contacts`);
    if (status === 401) return res.status(401).json({ erro: 'Token Kommo inválido ou expirado (401)' });
    if (status === 404) return res.status(404).json({ erro: 'Lead #' + req.params.id + ' não encontrado no Kommo' });
    if (status !== 200) return res.status(status).json({ erro: 'Kommo retornou erro ' + status });

    const lead = body;
    // Prioridade: nome do CONTATO (pessoa real) > nome do lead (pode ser "Lead #XXXXX")
    let nome = '';
    let cel = '';
    const contactLinks = lead._embedded?.contacts || [];
    if (contactLinks.length > 0) {
      try {
        const contId = contactLinks[0].id;
        const cr = await kommoGet(`/contacts/${contId}`);
        if (cr.status === 200) {
          const contact = cr.body;
          nome = contact.name || '';
          const phones = (contact.custom_fields_values || []).find(f => f.field_code === 'PHONE');
          if (phones && phones.values && phones.values.length > 0) {
            cel = phones.values[0].value || '';
          }
        }
      } catch {}
    }
    // Só usa o nome do lead como fallback se não achou contato
    if (!nome) nome = lead.name || '';
    if (req.query.raw === '1') {
      return res.json({ id: lead.id, nome, custom_fields_values: lead.custom_fields_values || null, source_id: lead.source_id || null, tags: lead._embedded?.tags || null, pipeline_id: lead.pipeline_id, status_id: lead.status_id });
    }
    res.json({ id: lead.id, nome, cel, status_id: lead.status_id, pipeline_id: lead.pipeline_id, valor: lead.price });
  } catch (e) {
    console.error('[Kommo] Erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── KOMMO: criar tarefa no lead com prazo D-1 (pula fim de semana para sexta) ──
app.post('/api/kommo/lead/:id/mensagem', auth, async (req, res) => {
  const leadId = req.params.id;
  const { texto, data_visita } = req.body;
  if (!texto) return res.status(400).json({ erro: 'Texto da mensagem é obrigatório' });

  try {
    // Calcula prazo: 1 dia antes da visita, pulando fim de semana para sexta-feira
    let completeTill = null;
    let prazoTexto = null;
    const dias = ['dom','seg','ter','qua','qui','sex','sáb'];
    if (data_visita) {
      // data_visita formato: 'YYYY-MM-DD' (data local BR)
      // Cria data às 09:00 horário de Brasília (UTC-3)
      const d = new Date(data_visita + 'T09:00:00-03:00');
      d.setDate(d.getDate() - 1); // D-1
      if (d.getDay() === 0) d.setDate(d.getDate() - 2); // domingo → sexta
      if (d.getDay() === 6) d.setDate(d.getDate() - 1); // sábado → sexta
      completeTill = Math.floor(d.getTime() / 1000);
      prazoTexto = `${dias[d.getDay()]} ${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}`;
    }
    // Kommo exige complete_till obrigatório — usa amanhã 09h como fallback
    if (!completeTill) {
      const amanha = new Date();
      amanha.setDate(amanha.getDate() + 1);
      amanha.setHours(12, 0, 0, 0); // 09:00 BRT ≈ 12:00 UTC
      completeTill = Math.floor(amanha.getTime() / 1000);
      prazoTexto = `${dias[amanha.getDay()]} ${amanha.getDate().toString().padStart(2,'0')}/${(amanha.getMonth()+1).toString().padStart(2,'0')} (sem data)`;
    }

    // Cria tarefa vinculada ao lead
    const tarefaPayload = [{
      task_type_id: 1, // 1 = Ligação (ícone padrão de lembrete)
      text: `📅 Lembrar da visita agendada:\n\n${texto}`,
      complete_till: completeTill,
      entity_id: parseInt(leadId),
      entity_type: 'leads'
    }];

    const { status: sTarefa, body: tarefaResp } = await kommoPost('/tasks', tarefaPayload);

    if (sTarefa === 200 || sTarefa === 201) {
      const taskId = tarefaResp?._embedded?.tasks?.[0]?.id || null;
      console.log(`[Kommo] Tarefa ${taskId} criada no lead ${leadId}, prazo: ${prazoTexto}`);
      res.json({
        sucesso: true,
        tarefa: true,
        task_id: taskId,
        prazo_tarefa: prazoTexto,
        url_lead: `https://${KOMMO_SUBDOMAIN}.kommo.com/leads/detail/${leadId}`
      });
    } else {
      console.error('[Kommo tarefa] Erro status:', sTarefa, JSON.stringify(tarefaResp));
      res.status(500).json({ erro: `Erro ao criar tarefa no Kommo (status ${sTarefa})` });
    }
  } catch (e) {
    console.error('[Kommo tarefa] Erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── KOMMO: pipelines (nomes das etapas/campanhas) ──
let _kommoPipelines = null;
let _kommoPipelinesTs = 0;
async function getKommoPipelines() {
  const now = Date.now();
  if (_kommoPipelines && now - _kommoPipelinesTs < 5 * 60 * 1000) return _kommoPipelines;
  try {
    const { status, body } = await kommoGet('/pipelines?limit=50');
    if (status === 200 && body._embedded?.pipelines) {
      _kommoPipelines = {};
      for (const p of body._embedded.pipelines) {
        _kommoPipelines[p.id] = { nome: p.name, statuses: {} };
        for (const s of (p._embedded?.statuses || [])) {
          _kommoPipelines[p.id].statuses[s.id] = s.name;
        }
      }
      _kommoPipelinesTs = now;
    }
  } catch {}
  return _kommoPipelines || {};
}

// ── KOMMO: leads por período ──
app.get('/api/kommo/periodo', auth, async (req, res) => {
  try {
    const pipelines = await getKommoPipelines();
    // Período via query params (timestamps Unix) ou padrão = hoje
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const inicio = parseInt(req.query.de)  || Math.floor(hoje.getTime() / 1000);
    const fim    = parseInt(req.query.ate) || Math.floor((hoje.getTime() + 86400000 - 1) / 1000);

    const { status, body } = await kommoGet(
      `/leads?filter[created_at][from]=${inicio}&filter[created_at][to]=${fim}&with=contacts,custom_fields&limit=100&order[created_at]=desc`
    );
    if (status !== 200) return res.status(status).json({ erro: 'Erro ao buscar leads no Kommo', detalhe: body });

    const leads = body._embedded?.leads || [];
    const resultado = leads.map(l => {
      const pipeline = pipelines[l.pipeline_id] || {};
      const status_nome = pipeline.statuses?.[l.status_id] || 'Desconhecido';
      const pipeline_nome = pipeline.nome || 'Sem funil';

      // Campanha via custom fields UTM
      const utmSource   = (l.custom_fields_values || []).find(f => f.field_code === 'UTM_SOURCE');
      const utmCampaign = (l.custom_fields_values || []).find(f => f.field_code === 'UTM_CAMPAIGN');
      const campanha = utmCampaign?.values?.[0]?.value || utmSource?.values?.[0]?.value || pipeline_nome;

      const contatos = (l._embedded?.contacts || []).map(c => ({ id: c.id, nome: c.name || '' }));
      return {
        id: l.id,
        nome: l.name || '',
        criado_em: l.created_at,
        valor: l.price || 0,
        pipeline: pipeline_nome,
        status: status_nome,
        campanha,
        contatos
      };
    });

    // Agrupa por campanha
    const por_campanha = {};
    for (const l of resultado) {
      if (!por_campanha[l.campanha]) por_campanha[l.campanha] = 0;
      por_campanha[l.campanha]++;
    }

    res.json({ total: resultado.length, por_campanha, leads: resultado });
  } catch (e) {
    console.error('[Kommo hoje] Erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── KOMMO: funil do dia — cruza leads do Kommo com visitas/propostas do Alery ──
app.post('/api/kommo/funil', auth, (req, res) => {
  try {
    const idsAll = (req.body?.lead_ids || []).map(x => String(x).trim()).filter(Boolean).slice(0, 3000);
    if (!idsAll.length) return res.json({ visitas: {}, propostas: {} });
    const visitas = {};
    const propostas = {};
    for (let i = 0; i < idsAll.length; i += 500) {
      const ids = idsAll.slice(i, i + 500);
      const ph = ids.map(() => '?').join(',');
      const vis = db.prepare(`SELECT TRIM(lead_id) AS lid, COUNT(*) AS n FROM visitas WHERE TRIM(COALESCE(lead_id,'')) IN (${ph}) GROUP BY TRIM(lead_id)`).all(...ids);
      const props = db.prepare(`SELECT TRIM(lead_id) AS lid, status FROM aprovacoes WHERE TRIM(COALESCE(lead_id,'')) IN (${ph})`).all(...ids);
      vis.forEach(v => { visitas[v.lid] = v.n; });
      props.forEach(p => {
        if (!propostas[p.lid]) propostas[p.lid] = { total: 0, aprovadas: 0 };
        propostas[p.lid].total++;
        if (p.status === 'aprovado') propostas[p.lid].aprovadas++;
      });
    }
    res.json({ visitas, propostas });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── KOMMO: cruza leads de capa térmica com vendas do Tiny (por telefone) ──
// Recebe [{lead_id, tel}] e devolve quem comprou capa, casando pelos últimos 8 dígitos do telefone.
app.post('/api/kommo/vendas-capa', auth, (req, res) => {
  try {
    const leads = Array.isArray(req.body?.leads) ? req.body.leads.slice(0, 3000) : [];
    const pedidos = db.prepare(
      "SELECT id,numero,cliente,valor,data,telefone,itens,tem_capa,lead_id FROM tiny_pedidos WHERE tem_capa=1"
    ).all();
    // Total vendido no período, independente de conseguir ligar ao lead
    const de  = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.de  || '') ? req.body.de  : null;
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.ate || '') ? req.body.ate : null;
    const noPeriodo = (de && ate)
      ? pedidos.filter(p => p.data >= de && p.data <= ate)
      : pedidos;
    // A capa é vendida por m², então somar as quantidades daria metragem, não peças.
    // Conta uma capa por item de capa do pedido, e a metragem à parte.
    let capasVendidas = 0, metrosCapa = 0;
    for (const p of noPeriodo) {
      try {
        const itensCapa = JSON.parse(p.itens || '[]').filter(i => itemEhCapa(i.descricao, i.sku));
        capasVendidas += itensCapa.length;
        metrosCapa += itensCapa.reduce((a, i) => a + (i.qtd || 0), 0);
      } catch {}
    }

    // Índice por telefone; um mesmo telefone pode ter comprado mais de uma vez
    const porTel = {};
    for (const p of pedidos) {
      const k = telKey(p.telefone);
      if (!k) continue;
      (porTel[k] = porTel[k] || []).push(p);
    }

    // Índice por nome completo normalizado, usado quando o telefone não resolve
    const nomeKey = s => _normTxt(s).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    const porNome = {};
    for (const p of pedidos) {
      const n = nomeKey(p.cliente);
      if (n && n.includes(' ')) (porNome[n] = porNome[n] || []).push(p); // exige nome + sobrenome
    }

    const casados = {};
    let comCompra = 0, viaTelefone = 0, viaNome = 0;
    for (const l of leads) {
      const k = telKey(l.tel);
      const achados = [];
      let origem = '';
      if (k && porTel[k]) achados.push(...porTel[k].filter(p => telCombina(p.telefone, l.tel)));
      if (achados.length) origem = 'telefone';
      // Reforço: nome completo idêntico ao do cadastro do pedido
      const n = nomeKey(l.nome);
      if (!achados.length && n && porNome[n]) {
        achados.push(...porNome[n]);
        if (achados.length) origem = 'nome';
      }
      // Vínculo manual pelo lead também vale
      for (const p of pedidos) {
        if (p.lead_id && String(p.lead_id).trim() === String(l.lead_id).trim() && !achados.includes(p)) {
          achados.push(p);
          origem = origem || 'lead';
        }
      }
      if (achados.length) {
        comCompra++;
        if (origem === 'telefone') viaTelefone++;
        if (origem === 'nome') viaNome++;
        casados[String(l.lead_id)] = achados.map(p => ({
          numero: p.numero, cliente: p.cliente, valor: p.valor, data: p.data, casado_por: origem,
          itens: (() => { try { return JSON.parse(p.itens || '[]').filter(i => itemEhCapa(i.descricao, i.sku)); } catch { return []; } })(),
        }));
      }
    }

    const valorTotal = Object.values(casados).flat().reduce((s, p) => s + (p.valor || 0), 0);
    res.json({
      leads_consultados: leads.length,
      leads_que_compraram: comCompra,
      casados_por_telefone: viaTelefone,
      casados_por_nome: viaNome,
      valor_total: valorTotal,
      // Vendas de capa no período, mesmo as que não foi possível ligar a um lead
      pedidos_periodo: noPeriodo.length,
      capas_vendidas_periodo: capasVendidas,
      metros_capa_periodo: Math.round(metrosCapa * 100) / 100,
      valor_periodo: noPeriodo.reduce((s, p) => s + (p.valor || 0), 0),
      sem_vinculo: noPeriodo.length - comCompra,
      // Lista detalhada para exibir ao clicar no card
      lista_periodo: noPeriodo.map(p => {
        let todosItens = [], itensCapa = [];
        try {
          todosItens = JSON.parse(p.itens || '[]');
          itensCapa = todosItens.filter(i => itemEhCapa(i.descricao, i.sku));
        } catch {}
        // Qual lead do Kommo corresponde a este pedido (se algum)
        const leadCasado = leads.find(l =>
          (p.telefone && telCombina(p.telefone, l.tel)) ||
          (nomeKey(p.cliente) && nomeKey(p.cliente).includes(' ') && nomeKey(p.cliente) === nomeKey(l.nome)) ||
          (p.lead_id && String(p.lead_id).trim() === String(l.lead_id).trim())
        );
        return {
          numero: p.numero, cliente: p.cliente, data: p.data, valor: p.valor || 0,
          telefone: p.telefone || '',
          qtd: itensCapa.length,                                                   // peças de capa
          metros: Math.round(itensCapa.reduce((s, i) => s + (i.qtd || 0), 0) * 100) / 100,  // m²
          produtos: itensCapa.map(i => i.descricao),
          // Todos os itens do pedido (capa e acessórios), para conferir o valor total
          itens: todosItens.map(i => ({
            descricao: i.descricao,
            qtd: i.qtd || 0,
            valor: i.valor || 0,
            total: Math.round((i.qtd || 0) * (i.valor || 0) * 100) / 100,
            eh_capa: itemEhCapa(i.descricao, i.sku),
          })),
          lead_id: leadCasado ? String(leadCasado.lead_id) : (p.lead_id || ''),
          lead_nome: leadCasado ? (leadCasado.nome || '') : '',
          motivo_sem_lead: leadCasado ? '' : (p.telefone ? 'telefone não bate com nenhum contato do período' : 'cadastro do Tiny sem telefone'),
        };
      }),
      pedidos_capa_no_sistema: pedidos.length,
      pedidos_capa_com_telefone: Object.values(porTel).flat().length,
      por_lead: casados,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MATERIAIS: calcula a lista de instalação a partir do laudo + modelo ──
const { calcularMateriais, REGRAS: REGRAS_INST } = require('./calc_materiais');

// Lista os modelos agrupados por linha comercial (para o seletor da vendedora)
app.get('/api/materiais/modelos', auth, (req, res) => {
  const ordem = REGRAS_INST.ordem_linhas || [];
  const grupos = {};
  for (const [nome, v] of Object.entries(REGRAS_INST.cabos_por_modelo)) {
    const linha = v.linha || 'Outros';
    (grupos[linha] = grupos[linha] || []).push({ nome, potencia_w: v.potencia_w });
  }
  // Dentro de cada linha, ordena pela capacidade (número do modelo)
  const numDe = s => parseInt(String(s).replace(/[^0-9]/g, ''), 10) || 0;
  const lista = Object.entries(grupos)
    .sort((a, b) => {
      const ia = ordem.indexOf(a[0]), ib = ordem.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .map(([linha, modelos]) => ({
      linha,
      modelos: modelos.sort((a, b) => numDe(a.nome) - numDe(b.nome)),
    }));
  const total = Object.keys(REGRAS_INST.cabos_por_modelo).length;
  // modelos[] mantido para compatibilidade com versões antigas da tela
  res.json({ total, grupos: lista, modelos: lista.flatMap(g => g.modelos) });
});

// Calcula a lista de materiais. Aceita visita_id (usa o laudo salvo) ou o laudo direto.
app.post('/api/materiais/calcular', auth, (req, res) => {
  try {
    const { visita_id, modelo } = req.body || {};
    let laudo = req.body?.laudo || null;
    if (!laudo && visita_id) {
      const v = db.prepare('SELECT laudo FROM visitas WHERE id=?').get(visita_id);
      if (v?.laudo) { try { laudo = JSON.parse(v.laudo); } catch {} }
    }
    if (!laudo) return res.status(400).json({ erro: 'Informe visita_id (com laudo salvo) ou o laudo.' });
    if (!modelo) return res.status(400).json({ erro: 'Informe o modelo do trocador.' });

    const r = calcularMateriais(laudo, modelo);

    // Fonte de materiais: catálogo local + itens já usados em orçamentos anteriores.
    // O histórico é a melhor referência — traz o nome, SKU e preço exatos que a equipe usa.
    const catalogo = db.prepare('SELECT sku,nome,unidade,preco_venda AS preco FROM materiais_catalogo WHERE ativo=1').all();
    const historico = db.prepare(`
      SELECT sku, nome, unidade, preco_unit AS preco, MAX(id) AS ult
      FROM orcamentos_mat_itens
      WHERE TRIM(COALESCE(sku,'')) != '' AND preco_unit > 0
      GROUP BY UPPER(TRIM(sku))
      ORDER BY ult DESC
    `).all();
    const fontes = [...historico, ...catalogo];

    const norm = s => String(s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const palavras = s => norm(s).split(' ').filter(p => p.length > 2);

    const itens = r.itens.map(it => {
      // "busca" é o termo de procura; quando ausente usa o próprio nome
      const termo = it.busca || it.nome;
      const alvoP = palavras(termo);
      // Números são decisivos: "joelho 45" não pode casar com "joelho 90",
      // nem "fio 2,50mm" com "fio 4,00mm". Todos precisam estar no nome do produto.
      const numsAlvo = (norm(termo).match(/\b\d+\b/g) || []);
      let melhor = null, melhorScore = 0;
      for (const c of fontes) {
        const nc = norm(c.nome);
        if (!nc) continue;
        const numsProd = (nc.match(/\d+/g) || []);
        if (numsAlvo.some(n => !numsProd.includes(n))) continue;
        const cP = palavras(c.nome);
        // Pontua pela fração de palavras do termo encontradas no nome do produto
        let achou = 0;
        for (const p of alvoP) if (nc.includes(p)) achou++;
        if (!achou) continue;
        let score = achou / alvoP.length;
        // Exige boa cobertura para evitar casar "Tubo" com qualquer coisa que tenha tubo
        if (score < 0.6) continue;
        // Desempate: prefere nomes mais curtos (mais específicos) e do histórico
        score += 0.2 * (1 / (1 + Math.abs(cP.length - alvoP.length)));
        if (score > melhorScore) { melhorScore = score; melhor = c; }
      }
      const preco = melhor?.preco || 0;
      // Item sem correspondência entra na lista mesmo assim, marcado para cadastro
      const obs = melhor ? (it.obs || '') : ['CADASTRAR', it.obs].filter(Boolean).join(' · ');
      return {
        ...it,
        obs,
        sku: melhor?.sku || null,
        sku_display: melhor?.sku || '⚠ CADASTRAR',
        nome_catalogo: melhor?.nome || null,
        unidade: melhor?.unidade || it.unidade,
        preco_unit: preco,
        preco_total: Math.round(preco * it.quantidade * 100) / 100,
        encontrado_no_catalogo: !!melhor,
      };
    });
    const total = itens.reduce((s, i) => s + (i.preco_total || 0), 0);
    const semPreco = itens.filter(i => !i.encontrado_no_catalogo).map(i => i.nome);
    const avisos = [...r.avisos];
    if (semPreco.length) {
      avisos.push(`${semPreco.length} item(ns) não encontrado(s) no Tiny — entraram na lista marcados como CADASTRAR, com preço a preencher: ${semPreco.join(', ')}`);
    }

    res.json({ ...r, itens, valor_total: Math.round(total * 100) / 100, avisos });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── FECHAMENTOS: pedidos de capa térmica do período ──
app.get('/api/fechamentos/capas', auth, (req, res) => {
  try {
    const de  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de  || '') ? req.query.de  : '0000-01-01';
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : '9999-12-31';
    const rows = db.prepare(
      "SELECT id,numero,cliente,valor,data,vendedora,telefone,itens,situacao FROM tiny_pedidos " +
      "WHERE tem_capa=1 AND data >= ? AND data <= ? ORDER BY data DESC"
    ).all(de, ate);
    const pedidos = rows.map(p => {
      let itens = [];
      try { itens = JSON.parse(p.itens || '[]'); } catch {}
      const itensCapa = itens.filter(i => itemEhCapa(i.descricao, i.sku));
      return {
        id: p.id, numero: p.numero, cliente: p.cliente, data: p.data,
        vendedora: p.vendedora || '', valor: p.valor || 0, situacao: p.situacao || '',
        telefone: p.telefone || '',
        // A capa é vendida por m²: qtd_capas conta peças, metros_capa guarda a metragem
        qtd_capas: itensCapa.length,
        metros_capa: Math.round(itensCapa.reduce((s, i) => s + (i.qtd || 0), 0) * 100) / 100,
        valor_capas: itensCapa.reduce((s, i) => s + (i.qtd || 0) * (i.valor || 0), 0),
        produtos: itensCapa.map(i => i.descricao),
      };
    });
    res.json({
      total: pedidos.length,
      valor_total: pedidos.reduce((s, p) => s + p.valor, 0),
      valor_capas: pedidos.reduce((s, p) => s + p.valor_capas, 0),
      qtd_capas: pedidos.reduce((s, p) => s + p.qtd_capas, 0),
      metros_capa: Math.round(pedidos.reduce((s, p) => s + (p.metros_capa || 0), 0) * 100) / 100,
      pedidos,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── FECHAMENTOS: conversão por campanha (leads do Kommo × vendas) ──
app.get('/api/fechamentos/conversao', auth, async (req, res) => {
  try {
    const de  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de  || '') ? req.query.de  : null;
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : null;
    if (!de || !ate) return res.status(400).json({ erro: 'Informe o período (de/ate).' });
    const inicio = Math.floor(new Date(de  + 'T00:00:00-03:00').getTime() / 1000);
    const fim    = Math.floor(new Date(ate + 'T23:59:59-03:00').getTime() / 1000);

    // 1. Leads do Kommo no período (o Kommo ignora filtro de data em /talks — filtramos aqui)
    let talks = [];
    for (let pg = 1; pg <= 20; pg++) {
      const { status, body } = await kommoGet(`/talks?limit=250&page=${pg}`);
      if (status === 204) break;
      if (status !== 200) { if (pg === 1) return res.status(status).json({ erro: `Kommo retornou ${status}` }); break; }
      const page = body._embedded?.talks || [];
      talks = talks.concat(page.filter(t => t.created_at >= inicio && t.created_at <= fim));
      if (page.length < 250) break;
    }
    const leadMap = {};
    for (const t of talks) {
      if (!t.entity_id || t.entity_type !== 'lead') continue;
      if (!leadMap[t.entity_id] || t.created_at < leadMap[t.entity_id].created_at) {
        leadMap[t.entity_id] = { created_at: t.created_at, contact_id: t.contact_id };
      }
    }
    const leadIds = Object.keys(leadMap).map(Number);

    // 2. Origem de cada lead: nota "Primeira mensagem" gravada pelo Salesbot no contato
    const contactIds = new Set();
    const leadsById = {};
    for (let i = 0; i < leadIds.length; i += 50) {
      const q = leadIds.slice(i, i + 50).map(id => `filter[id][]=${id}`).join('&');
      try {
        const { status, body } = await kommoGet(`/leads?${q}&with=contacts&limit=250`);
        if (status === 200) for (const l of body._embedded?.leads || []) {
          leadsById[l.id] = l;
          for (const c of l._embedded?.contacts || []) contactIds.add(c.id);
        }
      } catch {}
    }
    for (const [lid, tk] of Object.entries(leadMap)) if (tk.contact_id) contactIds.add(tk.contact_id);
    const contatoInfo = {};
    const cIds = [...contactIds];
    for (let i = 0; i < cIds.length; i += 50) {
      const q = cIds.slice(i, i + 50).map(id => `filter[entity_id][]=${id}`).join('&');
      try {
        const { status, body } = await kommoGet(`/contacts/notes?${q}&limit=250`);
        if (status === 200) for (const n of body._embedded?.notes || []) {
          const m = String(n.params?.text || '').match(/^Primeira mensagem:\s*([\s\S]+)/i);
          if (m && !contatoInfo[n.entity_id]) contatoInfo[n.entity_id] = m[1].trim();
        }
      } catch {}
    }
    const telPorContato = {};
    for (let i = 0; i < cIds.length; i += 50) {
      const q = cIds.slice(i, i + 50).map(id => `filter[id][]=${id}`).join('&');
      try {
        const { status, body } = await kommoGet(`/contacts?${q}&limit=250`);
        if (status === 200) for (const c of body._embedded?.contacts || []) {
          const ph = (c.custom_fields_values || []).find(f => f.field_code === 'PHONE');
          telPorContato[c.id] = { tel: ph?.values?.[0]?.value || '', nome: c.name || '' };
        }
      } catch {}
    }

    // 3. Classifica cada lead por campanha
    const campanhaDe = txt => {
      const t = _normTxt(txt);
      if (!t) return 'sem_origem';
      if (t.includes('s12')) return 's12';
      if (t.includes('prime') || t.includes('inverter')) return 'prime';
      if (t.includes('capa') || t.includes('termic') || t.includes('posso ter mais informa')) return 'capa';
      return 'outros';
    };
    const leads = [];
    for (const [lidStr, tk] of Object.entries(leadMap)) {
      const lid = Number(lidStr);
      const lead = leadsById[lid];
      const cid = tk.contact_id || lead?._embedded?.contacts?.[0]?.id;
      const info = cid ? telPorContato[cid] : null;
      const msg = (cid && contatoInfo[cid]) || '';
      leads.push({ lead_id: lid, campanha: campanhaDe(msg), tel: info?.tel || '', nome: info?.nome || lead?.name || '' });
    }

    // 4. Vendas de equipamento por lead. Duas fontes, unidas pelo lead:
    //    instalações (onde o lead é preenchido na prática) e propostas aprovadas.
    //    Sem filtro de data na venda: mede a safra de leads do período — um contato de
    //    agosto que fecha em setembro continua contando como conversão daquela campanha.
    const vendaPorLead = {};
    const marcarVenda = (leadId, valor, fonte) => {
      const k = String(leadId || '').trim();
      if (!k) return;
      if (!vendaPorLead[k]) vendaPorLead[k] = { valor: 0, fontes: [] };
      vendaPorLead[k].valor += valor || 0;
      if (!vendaPorLead[k].fontes.includes(fonte)) vendaPorLead[k].fontes.push(fonte);
    };
    for (const i of db.prepare("SELECT lead_id, valor FROM instalacoes WHERE TRIM(COALESCE(lead_id,'')) != ''").all()) {
      marcarVenda(i.lead_id, i.valor, 'instalacao');
    }
    for (const a of db.prepare("SELECT lead_id, valor FROM aprovacoes WHERE status='aprovado' AND TRIM(COALESCE(lead_id,'')) != ''").all()) {
      // Só soma o valor se esse lead ainda não veio de uma instalação (evita contar a mesma venda duas vezes)
      const k = String(a.lead_id).trim();
      if (vendaPorLead[k]?.fontes.includes('instalacao')) continue;
      marcarVenda(a.lead_id, a.valor, 'proposta');
    }
    const pedCapa = db.prepare(
      "SELECT telefone, cliente, valor FROM tiny_pedidos WHERE tem_capa=1"
    ).all();
    // Vendas de capa do próprio período — mostradas mesmo quando não dá para ligar ao lead
    const capasNoPeriodo = db.prepare(
      "SELECT COUNT(*) n, COALESCE(SUM(valor),0) v FROM tiny_pedidos WHERE tem_capa=1 AND data >= ? AND data <= ?"
    ).get(de, ate);
    const nomeKey = s => _normTxt(s).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

    // Visitas e propostas por lead (etapas do funil de equipamento)
    const visitaPorLead = {};
    for (const v of db.prepare("SELECT lead_id FROM visitas WHERE TRIM(COALESCE(lead_id,'')) != ''").all()) {
      visitaPorLead[String(v.lead_id).trim()] = true;
    }
    const propPorLead = {};
    for (const p of db.prepare("SELECT lead_id, status FROM aprovacoes WHERE TRIM(COALESCE(lead_id,'')) != ''").all()) {
      const k = String(p.lead_id).trim();
      propPorLead[k] = propPorLead[k] || { total: 0, aprovadas: 0 };
      propPorLead[k].total++;
      if (p.status === 'aprovado') propPorLead[k].aprovadas++;
    }

    // ── Funil de equipamento: só S12 e Prime, que passam por visita e proposta ──
    const equip = { leads: 0, visitas: 0, propostas: 0, aprovadas: 0, vendas: 0, valor: 0, por_campanha: {} };
    // ── Capa térmica: venda direta, mede só lead → venda ──
    const capa = { leads: 0, vendas: 0, valor: 0 };
    const outros = { leads: 0, vendas: 0, valor: 0 };

    for (const l of leads) {
      const k = String(l.lead_id);
      const ehEquip = l.campanha === 's12' || l.campanha === 'prime';
      if (ehEquip) {
        equip.leads++;
        const pc = equip.por_campanha[l.campanha] = equip.por_campanha[l.campanha] || { leads: 0, visitas: 0, propostas: 0, aprovadas: 0, valor: 0 };
        pc.leads++;
        if (visitaPorLead[k]) { equip.visitas++; pc.visitas++; }
        const pr = propPorLead[k];
        if (pr) {
          equip.propostas += pr.total; pc.propostas += pr.total;
          equip.aprovadas += pr.aprovadas; pc.aprovadas += pr.aprovadas;
        }
        const venda = vendaPorLead[k];
        if (venda) { equip.vendas++; equip.valor += venda.valor || 0; pc.valor += venda.valor || 0; }
      } else if (l.campanha === 'capa') {
        capa.leads++;
        const pCapa = pedCapa.find(p =>
          (p.telefone && telCombina(p.telefone, l.tel)) ||
          (nomeKey(p.cliente) && nomeKey(p.cliente).includes(' ') && nomeKey(p.cliente) === nomeKey(l.nome))
        );
        const vEquip = vendaPorLead[k]; // cliente de capa que acabou comprando equipamento também conta
        if (pCapa || vEquip) { capa.vendas++; capa.valor += (pCapa?.valor || 0) + (vEquip?.valor || 0); }
      } else {
        outros.leads++;
        const venda = vendaPorLead[k];
        const pCapa = pedCapa.find(p => p.telefone && telCombina(p.telefone, l.tel));
        if (venda || pCapa) { outros.vendas++; outros.valor += (venda?.valor || 0) + (!venda && pCapa ? (pCapa.valor || 0) : 0); }
      }
    }

    const pct = (a, b) => (b ? a / b : 0);
    const rotulos = { s12: 'Ortum S12', prime: 'Prime Full Inverter' };
    res.json({
      periodo: { de, ate },
      total_leads: leads.length,
      equipamentos: {
        ...equip,
        conversao: pct(equip.vendas, equip.leads),
        tx_visita: pct(equip.visitas, equip.leads),
        tx_proposta: pct(equip.propostas, equip.leads),
        por_campanha: Object.entries(equip.por_campanha).map(([k, v]) => ({
          campanha: k, rotulo: rotulos[k] || k, ...v, conversao: pct(v.aprovadas, v.leads),
        })),
      },
      capa: {
        ...capa,
        conversao: pct(capa.vendas, capa.leads),
        pedidos_no_periodo: capasNoPeriodo.n,       // total vendido, venha de onde vier
        valor_no_periodo: capasNoPeriodo.v,
        sem_origem_identificada: Math.max(capasNoPeriodo.n - capa.vendas, 0),
      },
      outros: { ...outros, conversao: pct(outros.vendas, outros.leads) },
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── TINY: completa o telefone dos pedidos de capa que estão sem ──
// Bem mais leve que re-sincronizar: mexe só nos pedidos de capa sem telefone.
app.post('/api/tiny/completar-telefones', auth, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado.' });
  const pend = db.prepare(
    "SELECT id, tiny_id, cliente FROM tiny_pedidos WHERE tem_capa=1 AND COALESCE(telefone,'')='' LIMIT 40"
  ).all();
  if (!pend.length) return res.json({ sucesso: true, atualizados: 0, pendentes: 0, mensagem: 'Nenhum pedido de capa sem telefone.' });

  const upd = db.prepare('UPDATE tiny_pedidos SET telefone=? WHERE id=?');
  let ok = 0; const falhas = [];
  for (const p of pend) {
    try {
      // 1) pesquisa o contato pelo nome do cliente do pedido
      const b = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pesquisa: p.cliente || '' }).toString();
      const r = await fetch('https://api.tiny.com.br/api2/contatos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
      const d = await r.json();
      if (d?.retorno?.status !== 'OK') { falhas.push({ cliente: p.cliente, motivo: d?.retorno?.erros?.[0]?.erro || 'pesquisa falhou' }); await new Promise(s => setTimeout(s, 800)); continue; }
      const c0 = (d.retorno.contatos || [])[0];
      const ct = c0?.contato || c0;
      let tel = String(ct?.celular || ct?.fone || '').trim();
      // 2) o telefone quase sempre só vem no detalhe do contato
      if (!tel && ct?.id) {
        await new Promise(s => setTimeout(s, 600));
        const b2 = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id: String(ct.id) }).toString();
        const r2 = await fetch('https://api.tiny.com.br/api2/contato.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b2 });
        const d2 = await r2.json();
        const det = d2?.retorno?.contato;
        tel = String(det?.celular || det?.fone || '').trim();
      }
      if (tel) { upd.run(tel, p.id); ok++; }
      else falhas.push({ cliente: p.cliente, motivo: 'contato sem telefone cadastrado' });
    } catch (e) { falhas.push({ cliente: p.cliente, motivo: e.message }); }
    await new Promise(s => setTimeout(s, 800)); // respeita o limite de acessos da Tiny
  }
  const restam = db.prepare("SELECT COUNT(*) n FROM tiny_pedidos WHERE tem_capa=1 AND COALESCE(telefone,'')=''").get().n;
  res.json({ sucesso: true, processados: pend.length, atualizados: ok, ainda_sem_telefone: restam, falhas });
});

// ── TINY: concilia os pedidos do período entre o Tiny e o Alery ──
// Mostra o que está em um lado e não no outro, e onde os valores divergem.
app.get('/api/tiny/conciliacao', auth, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token Tiny não configurado.' });
  const de  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de  || '') ? req.query.de  : null;
  const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : null;
  if (!de || !ate) return res.status(400).json({ erro: 'Informe de e ate (YYYY-MM-DD).' });
  const toDDMMYYYY = s => s.split('-').reverse().join('/');

  try {
    // 1. Todos os pedidos do Tiny no período
    const doTiny = [];
    let pagina = 1, totalPags = 1;
    while (pagina <= totalPags) {
      const body = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', dataInicial: toDDMMYYYY(de), dataFinal: toDDMMYYYY(ate), pagina: String(pagina) }).toString();
      const r = await fetch('https://api.tiny.com.br/api2/pedidos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const d = await r.json();
      if (d.retorno?.status !== 'OK') {
        if (pagina === 1) return res.status(400).json({ erro: d.retorno?.erros?.[0]?.erro || 'Erro na API Tiny.' });
        break;
      }
      totalPags = parseInt(d.retorno?.numero_paginas || '1');
      for (const p of (d.retorno?.pedidos || [])) {
        const it = p.pedido || p;
        doTiny.push({
          id: String(it.id || ''), numero: String(it.numero || ''), cliente: it.nome || '',
          valor: parseFloat(String(it.valor || '0').replace(',', '.')) || 0,
          situacao: it.situacao || '',
          numero_ecommerce: String(it.numero_ecommerce || '').trim(),
        });
      }
      pagina++;
      if (pagina <= totalPags) await new Promise(s => setTimeout(s, 300));
    }

    // 2. O que o Alery tem no mesmo período
    const noAleryLF = db.prepare('SELECT tiny_id,numero,cliente,valor,situacao FROM tiny_pedidos WHERE data >= ? AND data <= ?').all(de, ate);
    const noAleryEC = db.prepare('SELECT tiny_id,numero,cliente,valor,situacao,canal FROM ecommerce_pedidos WHERE data >= ? AND data <= ?').all(de, ate);
    const mapaLF = new Map(noAleryLF.map(p => [String(p.tiny_id), p]));
    const mapaEC = new Map(noAleryEC.map(p => [String(p.tiny_id), p]));

    const ehCancelado = s => /cancel/i.test(s || '');
    // Loja física = pedido sem vínculo de e-commerce E com o marcador "Loja Física".
    // O marcador vem no detalhe do pedido, então busca só os candidatos.
    const semEc = doTiny.filter(p => !p.numero_ecommerce);
    const normM = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const temMarcadorLF = tags => tags.some(t => normM(t).includes('loja') && normM(t).includes('fisica'));
    const tinyLF = [];
    for (let i = 0; i < semEc.length; i += 5) {
      const lote = semEc.slice(i, i + 5);
      const dets = await Promise.all(lote.map(async p => {
        try {
          const b = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id: p.id }).toString();
          const r = await fetch('https://api.tiny.com.br/api2/pedido.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
          return (await r.json())?.retorno?.pedido || null;
        } catch { return null; }
      }));
      dets.forEach((ped, k) => {
        let tags = [];
        if (ped) {
          if (Array.isArray(ped.marcadores)) tags = ped.marcadores.map(m => String(m.marcador?.descricao || m.descricao || m));
          else if (typeof ped.marcadores === 'string' && ped.marcadores) tags = ped.marcadores.split(',');
        }
        if (temMarcadorLF(tags)) tinyLF.push({ ...lote[k], marcadores: tags });
      });
      if (i + 5 < semEc.length) await new Promise(s => setTimeout(s, 400));
    }
    const soma = arr => Math.round(arr.reduce((s, p) => s + (p.valor || 0), 0) * 100) / 100;

    const faltamNoAlery = tinyLF.filter(p => !mapaLF.has(p.id) && !mapaEC.has(p.id));
    const idsTiny = new Set(doTiny.map(p => p.id));
    const sobramNoAlery = noAleryLF.filter(p => !idsTiny.has(String(p.tiny_id)));
    const divergentes = [];
    for (const p of tinyLF) {
      const a = mapaLF.get(p.id);
      if (a && Math.abs((a.valor || 0) - p.valor) > 0.01) {
        divergentes.push({ numero: p.numero, cliente: p.cliente, valor_tiny: p.valor, valor_alery: a.valor });
      }
    }

    res.json({
      periodo: { de, ate },
      criterio_loja_fisica: 'sem vínculo de e-commerce + marcador "Loja Física" no Tiny',
      tiny: {
        total_pedidos: doTiny.length,
        sem_ecommerce: semEc.length,
        sem_ecommerce_sem_marcador: semEc.length - tinyLF.length,
        loja_fisica: { pedidos: tinyLF.length, valor: soma(tinyLF) },
        loja_fisica_sem_cancelados: {
          pedidos: tinyLF.filter(p => !ehCancelado(p.situacao)).length,
          valor: soma(tinyLF.filter(p => !ehCancelado(p.situacao))),
        },
        com_ecommerce: doTiny.filter(p => p.numero_ecommerce).length,
      },
      alery: {
        loja_fisica: { pedidos: noAleryLF.length, valor: soma(noAleryLF) },
        loja_fisica_sem_cancelados: {
          pedidos: noAleryLF.filter(p => !ehCancelado(p.situacao)).length,
          valor: soma(noAleryLF.filter(p => !ehCancelado(p.situacao))),
        },
        ecommerce: { pedidos: noAleryEC.length, valor: soma(noAleryEC) },
      },
      diferencas: {
        faltam_no_alery: faltamNoAlery.map(p => ({ numero: p.numero, cliente: p.cliente, valor: p.valor, situacao: p.situacao })),
        sobram_no_alery: sobramNoAlery.map(p => ({ numero: p.numero, cliente: p.cliente, valor: p.valor, situacao: p.situacao })),
        valores_divergentes: divergentes,
      },
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── TINY: debug da busca de telefone no cadastro do contato ──
app.get('/api/tiny/debug-contato', auth, adminOnly, async (req, res) => {
  const tokenRow = db.prepare("SELECT valor FROM config WHERE chave='tiny_token'").get();
  if (!tokenRow) return res.status(400).json({ erro: 'Token não configurado.' });
  const termo = String(req.query.q || '').trim();
  if (!termo) return res.status(400).json({ erro: 'Informe ?q=nome ou cpf' });
  try {
    const b = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', pesquisa: termo }).toString();
    const r = await fetch('https://api.tiny.com.br/api2/contatos.pesquisa.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
    const d = await r.json();
    const lista = Array.isArray(d?.retorno?.contatos) ? d.retorno.contatos : [];
    // A pesquisa devolve resumo (fone costuma vir vazio). Busca o detalhe pelo id.
    let detalhe = null;
    const c0 = lista[0]?.contato || lista[0];
    if (c0?.id) {
      const b2 = new URLSearchParams({ token: tokenRow.valor, formato: 'JSON', id: String(c0.id) }).toString();
      const r2 = await fetch('https://api.tiny.com.br/api2/contato.obter.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b2 });
      const d2 = await r2.json();
      const ct = d2?.retorno?.contato;
      detalhe = ct ? { status: d2?.retorno?.status, fone: ct.fone, celular: ct.celular, fax: ct.fax, chaves: Object.keys(ct) } : { status: d2?.retorno?.status, erros: d2?.retorno?.erros };
    }
    res.json({
      status_api: d?.retorno?.status,
      erros: d?.retorno?.erros,
      qtd: lista.length,
      pesquisa_fone: c0?.fone ?? null,
      detalhe_contato: detalhe,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── TINY: diagnóstico de itens de capa já sincronizados ──
app.get('/api/tiny/capas', auth, (req, res) => {
  try {
    const tot = db.prepare('SELECT COUNT(*) n FROM tiny_pedidos').get().n;
    const comItens = db.prepare('SELECT COUNT(*) n FROM tiny_pedidos WHERE itens IS NOT NULL').get().n;
    const comTel = db.prepare("SELECT COUNT(*) n FROM tiny_pedidos WHERE telefone IS NOT NULL AND telefone != ''").get().n;
    const capas = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(valor),0) v FROM tiny_pedidos WHERE tem_capa=1').get();
    const exemplos = db.prepare('SELECT numero,cliente,data,valor,itens FROM tiny_pedidos WHERE tem_capa=1 ORDER BY data DESC LIMIT 5').all()
      .map(p => ({ ...p, itens: (() => { try { return JSON.parse(p.itens || '[]'); } catch { return []; } })() }));
    res.json({
      pedidos_no_sistema: tot,
      com_itens_sincronizados: comItens,
      com_telefone: comTel,
      pedidos_com_capa: capas.n,
      valor_capas: capas.v,
      exemplos,
      aviso: comItens === 0 ? 'Nenhum pedido tem itens ainda — rode a sincronização do Tiny para o período desejado.' : null,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── KOMMO: debug de notas de um lead ──
app.get('/api/kommo/lead/:id/notas-debug', auth, async (req, res) => {
  try {
    const id = req.params.id;
    const a = await kommoGet(`/leads/notes?filter[entity_id][]=${id}&limit=50`);
    const b = await kommoGet(`/leads/${id}/notes?limit=50`);
    res.json({
      filtro:  { status: a.status, body: JSON.stringify(a.body).slice(0, 1200) },
      direto:  { status: b.status, body: JSON.stringify(b.body).slice(0, 1200) },
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── KOMMO: eventos/mensagens recentes ──
app.get('/api/kommo/eventos', auth, async (req, res) => {
  try {
    const { status, body } = await kommoGet(
      '/events?filter[type][]=incoming_chat_message&filter[type][]=outgoing_chat_message&filter[type][]=incoming_call&filter[type][]=outgoing_call&limit=30&order[created_at]=desc'
    );
    if (status !== 200) return res.status(status).json({ erro: 'Erro ao buscar eventos' });

    const eventos = (body._embedded?.events || []).map(e => ({
      id: e.id,
      tipo: e.type,
      criado_em: e.created_at,
      entity_id: e.entity_id,
      entity_type: e.entity_type,
      created_by: e.created_by,
      value_after: e.value_after?.[0] || null,
      value_before: e.value_before?.[0] || null
    }));

    res.json({ total: eventos.length, eventos });
  } catch (e) {
    console.error('[Kommo eventos] Erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── KOMMO: primeiros contatos do dia (por data exata) ──
app.get('/api/kommo/primeiras-mensagens', auth, async (req, res) => {
  try {
    const dataStr    = req.query.data || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dataFimStr = req.query.data_fim && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data_fim) ? req.query.data_fim : dataStr;
    // Timestamps em horário de Brasília (UTC-3)
    const inicio = Math.floor(new Date(dataStr + 'T00:00:00-03:00').getTime() / 1000);
    const fim    = Math.floor(new Date(dataFimStr + 'T23:59:59-03:00').getTime() / 1000);

    // 1. Busca TALKS (conversas WhatsApp — horário exato do 1º contato)
    // ATENÇÃO: o Kommo IGNORA filter[created_at] em /talks — filtramos aqui no servidor.
    // Pagina até 20 páginas (5000 talks = histórico completo atual) e filtra pelo período.
    let talks = [];
    for (let pg = 1; pg <= 20; pg++) {
      const { status: sTalks, body: talksBody } = await kommoGet(`/talks?limit=250&page=${pg}`);
      if (sTalks === 401) return res.status(401).json({ erro: 'Token Kommo inválido ou expirado (401) — atualize em Railway' });
      if (sTalks === 204) break;
      if (sTalks !== 200) {
        if (pg === 1) return res.status(sTalks).json({ erro: `Erro ao buscar talks Kommo (status ${sTalks})` });
        break;
      }
      const pageTalks = talksBody._embedded?.talks || [];
      talks = talks.concat(pageTalks.filter(t => t.created_at >= inicio && t.created_at <= fim));
      if (pageTalks.length < 250) break;
    }

    // Agrupa por lead: guarda o talk mais antigo por lead
    const leadTalkMap = {}; // leadId → { talk_id, created_at, contact_id }
    const contactIds = new Set();
    for (const t of talks) {
      if (!t.entity_id || t.entity_type !== 'lead') continue;
      const lid = t.entity_id;
      const talkId = t.id || t.talk_id; // Kommo usa t.id
      if (!leadTalkMap[lid] || t.created_at < leadTalkMap[lid].created_at) {
        leadTalkMap[lid] = { talk_id: talkId, created_at: t.created_at, contact_id: t.contact_id };
      }
      if (t.contact_id) contactIds.add(t.contact_id);
    }

    const leadIds = Object.keys(leadTalkMap).map(Number);
    if (leadIds.length === 0) {
      return res.json({ total: 0, data: dataStr, leads: [] });
    }

    // 2. Busca detalhes dos leads em lotes de 50 (nome, pipeline, custom fields)
    const leadsById = {};
    for (let i = 0; i < leadIds.length; i += 50) {
      try {
        const idsQuery = leadIds.slice(i, i + 50).map(id => `filter[id][]=${id}`).join('&');
        const { status: sL, body: lBody } = await kommoGet(`/leads?${idsQuery}&with=contacts&limit=250`);
        if (sL === 200) {
          for (const l of lBody._embedded?.leads || []) {
            leadsById[l.id] = l;
            for (const c of l._embedded?.contacts || []) contactIds.add(c.id);
          }
        }
      } catch {}
    }

    // 3. Busca nome e telefone dos contatos em lotes de 50
    const contatosTel = {};
    const allContactIds = [...contactIds];
    for (let i = 0; i < allContactIds.length; i += 50) {
      const idsQuery = allContactIds.slice(i, i + 50).map(id => `filter[id][]=${id}`).join('&');
      try {
        const { status: sC, body: cBody } = await kommoGet(`/contacts?${idsQuery}&limit=250`);
        if (sC === 200) {
          for (const c of cBody._embedded?.contacts || []) {
            const ph = (c.custom_fields_values || []).find(f => f.field_code === 'PHONE');
            contatosTel[c.id] = { nome: c.name || '', tel: ph?.values?.[0]?.value || '' };
          }
        }
      } catch {}
    }

    // 3.5 Busca notas "Primeira mensagem" criadas pelo Salesbot (workaround para falta de escopo chats)
    // O Salesbot grava a nota no CONTATO principal — busca em contacts/notes e mapeia contato → lead
    const notasPrimeira = {};
    const contactToLead = {};
    for (const [lidStr, tk] of Object.entries(leadTalkMap)) {
      if (tk.contact_id) contactToLead[tk.contact_id] = parseInt(lidStr);
    }
    for (const [lidStr] of Object.entries(leadTalkMap)) {
      const lid = parseInt(lidStr);
      for (const c of leadsById[lid]?._embedded?.contacts || []) {
        if (!contactToLead[c.id]) contactToLead[c.id] = lid;
      }
    }
    const cIdsNotas = Object.keys(contactToLead);
    for (let i = 0; i < cIdsNotas.length; i += 50) {
      const qN = cIdsNotas.slice(i, i + 50).map(id => `filter[entity_id][]=${id}`).join('&');
      try {
        const { status: sN, body: nBody } = await kommoGet(`/contacts/notes?${qN}&limit=250`);
        if (sN === 200) {
          for (const n of nBody._embedded?.notes || []) {
            const txt = n.params?.text || '';
            const m = txt.match(/^Primeira mensagem:\s*([\s\S]+)/i);
            const lidNota = contactToLead[n.entity_id];
            if (m && lidNota && !notasPrimeira[lidNota]) notasPrimeira[lidNota] = m[1].trim();
          }
        }
      } catch {}
    }

    // 4. Busca primeira mensagem de cada talk (texto enviado pelo cliente)
    const talkMsgs = {};
    const talkIds = [...new Set(Object.values(leadTalkMap).map(t => t.talk_id).filter(Boolean))];
    await Promise.all(talkIds.slice(0, 20).map(async tid => {
      try {
        const { status: sM, body: mBody } = await kommoGet(`/talks/${tid}/messages?limit=50`);
        console.log(`[Kommo debug] talk ${tid} msgs status=${sM} sample=`, JSON.stringify(mBody).slice(0, 300));
        if (sM === 200) {
          const msgs = mBody._embedded?.messages || [];
          const primeira = msgs.find(m => m.direction === 'in') || msgs[0];
          if (primeira) talkMsgs[tid] = primeira.content?.text || primeira.text || '';
        }
      } catch(e) { console.log(`[Kommo debug] talk ${tid} erro:`, e.message); }
    }));

    // 5. Monta resultado
    const resultado = [];
    for (const [lidStr, tkInfo] of Object.entries(leadTalkMap)) {
      const lid = parseInt(lidStr);
      const lead = leadsById[lid];
      const ctTalk = tkInfo.contact_id ? contatosTel[tkInfo.contact_id] : null;
      const ctLead = lead?._embedded?.contacts?.[0];
      const ctLeadInfo = ctLead ? contatosTel[ctLead.id] : null;
      const nome = ctTalk?.nome || ctLeadInfo?.nome || lead?.name || `Lead #${lid}`;
      const tel  = ctTalk?.tel  || ctLeadInfo?.tel  || '';
      // Fallback: campo custom "Primeira mensagem" preenchido por Salesbot no Kommo
      const cfPrimeira = (lead?.custom_fields_values || []).find(f => /primeira\s*mensagem/i.test(f.field_name || ''));
      const textoPrimeira = talkMsgs[tkInfo.talk_id] || cfPrimeira?.values?.[0]?.value || notasPrimeira[lid] || '';

      resultado.push({
        lead_id: lid,
        nome,
        tel,
        lead_name: lead?.name || '',
        primeiro_contato: tkInfo.created_at,
        texto_primeira: textoPrimeira,
        url: `https://${KOMMO_SUBDOMAIN}.kommo.com/leads/detail/${lid}`
      });
    }

    // Ordena por hora do primeiro contato (talk.created_at = hora exata da 1ª mensagem)
    resultado.sort((a, b) => (a.primeiro_contato || 0) - (b.primeiro_contato || 0));

    res.json({ total: resultado.length, data: dataStr, leads: resultado });
  } catch (e) {
    console.error('[Kommo primeiras-mensagens] Erro:', e.message);
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

// Auto-sync marketplace: roda na inicialização (após 60s) e a cada 4 horas
setTimeout(runAutoSyncMarketplace, 60 * 1000);
setInterval(runAutoSyncMarketplace, 4 * 60 * 60 * 1000);
// Verificação de cancelados: roda 30s após inicialização e a cada 1 hora
setTimeout(runCancelStatusCheck, 30 * 1000);
setInterval(runCancelStatusCheck, 60 * 60 * 1000);

app.listen(PORT, () => console.log('Capellato rodando na porta', PORT));
