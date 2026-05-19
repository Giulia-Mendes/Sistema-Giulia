const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── BANCO DE DADOS ──
const db = new Database('capellato.db');

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
`);

// ── CRIAR USUÁRIOS INICIAIS ──
function seed(nome, login, senha, role) {
  if (!db.prepare('SELECT id FROM usuarios WHERE login=?').get(login)) {
    db.prepare('INSERT INTO usuarios (nome,login,senha_hash,role) VALUES (?,?,?,?)').run(nome, login, bcrypt.hashSync(senha, 10), role);
  }
}
seed('Giulia Mendes', 'giulia', 'Flamengo@1', 'admin');
seed('Vitória', 'vitoria', 'capellato123', 'user');
seed('Aline', 'aline', 'capellato123', 'user');
seed('Márcia', 'marcia', 'capellato123', 'user');
seed('Joseilto', 'joseilto', 'capellato123', 'user');
seed('Wesley', 'wesley', 'capellato123', 'user');
seed('Caio', 'caio', 'capellato123', 'user');
seed('Gabriel', 'gabriel', 'capellato123', 'user');

// ── MIDDLEWARE ──
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'capellato2024secret',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  if (!req.session.u) return res.status(401).json({ erro: 'Não autenticado' });
  next();
}
function adminOnly(req, res, next) {
  if (!req.session.u || req.session.u.role !== 'admin') return res.status(403).json({ erro: 'Acesso negado' });
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

// ── USUÁRIOS ──
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
  const depois = db.prepare('SELECT id,nome,login,role,ativo FROM usuarios WHERE id=?').get(req.params.id);
  audit(req, 'EDITAR_USUARIO', 'usuarios', req.params.id, antes, depois);
  res.json({ sucesso: true });
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
  res.json(db.prepare('SELECT * FROM visitas ORDER BY criado_em DESC').all().map(v => ({
    ...v, tecnicos: JSON.parse(v.tecnicos || '[]'), fotos: JSON.parse(v.fotos || '[]'), laudo: v.laudo ? JSON.parse(v.laudo) : null
  })));
});
app.post('/api/visitas', auth, (req, res) => {
  const d = req.body;
  const r = db.prepare('INSERT INTO visitas (tipo,nome,cel,endereco,cep,data,hora_ini,hora_fim,obs,tecnicos,criado_por_id,criado_por_nome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(d.tipo, d.nome, d.cel, d.end, d.cep, d.data, d.horaIni, d.horaFim, d.obs, JSON.stringify(d.tecnicos || []), req.session.u.id, req.session.u.nome);
  audit(req, 'CRIAR_VISITA', 'visitas', r.lastInsertRowid, null, { nome: d.nome, data: d.data, tipo: d.tipo });
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/visitas/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT tipo,nome,cel,endereco,cep,data,hora_ini,hora_fim,obs FROM visitas WHERE id=?').get(req.params.id);
  const d = req.body;
  db.prepare('UPDATE visitas SET tipo=?,nome=?,cel=?,endereco=?,cep=?,data=?,hora_ini=?,hora_fim=?,obs=?,tecnicos=? WHERE id=?')
    .run(d.tipo, d.nome, d.cel, d.end, d.cep, d.data, d.horaIni, d.horaFim, d.obs, JSON.stringify(d.tecnicos || []), req.params.id);
  audit(req, 'EDITAR_VISITA', 'visitas', req.params.id, antes, { nome: d.nome, data: d.data, tipo: d.tipo });
  res.json({ sucesso: true });
});
app.put('/api/visitas/:id/laudo', auth, (req, res) => {
  const antes = db.prepare('SELECT laudo FROM visitas WHERE id=?').get(req.params.id);
  db.prepare('UPDATE visitas SET laudo=?,fotos=? WHERE id=?').run(JSON.stringify(req.body.laudo), JSON.stringify(req.body.fotos || []), req.params.id);
  audit(req, 'SALVAR_LAUDO', 'visitas', req.params.id, antes?.laudo ? JSON.parse(antes.laudo) : null, req.body.laudo);
  res.json({ sucesso: true });
});
app.delete('/api/visitas/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT nome,data,tipo FROM visitas WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM visitas WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_VISITA', 'visitas', req.params.id, antes, null);
  res.json({ sucesso: true });
});

// ── APROVAÇÕES ──
app.get('/api/aprovacoes', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM aprovacoes ORDER BY criado_em DESC').all());
});
app.post('/api/aprovacoes', auth, (req, res) => {
  const d = req.body;
  const r = db.prepare('INSERT INTO aprovacoes (cliente,vendedora,equip,valor,custo,margem,pag,status,texto,criado_por_id,criado_por_nome) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(d.cliente, d.vendedora, d.equip, d.valor, d.custo, d.margem, d.pag, 'pendente', d.texto, req.session.u.id, req.session.u.nome);
  audit(req, 'CRIAR_PROPOSTA', 'aprovacoes', r.lastInsertRowid, null, { cliente: d.cliente, valor: d.valor });
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/aprovacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,valor,status,texto FROM aprovacoes WHERE id=?').get(req.params.id);
  const d = req.body;
  db.prepare('UPDATE aprovacoes SET cliente=?,vendedora=?,equip=?,valor=?,custo=?,margem=?,pag=?,status=?,texto=? WHERE id=?')
    .run(d.cliente, d.vendedora, d.equip, d.valor, d.custo, d.margem, d.pag, d.status, d.texto, req.params.id);
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
  res.json(db.prepare('SELECT * FROM instalacoes ORDER BY criado_em DESC').all().map(i => ({
    ...i, anexos: JSON.parse(i.anexos || '[]'), checks: JSON.parse(i.checks || '{}')
  })));
});
app.post('/api/instalacoes', auth, (req, res) => {
  const d = req.body;
  const r = db.prepare('INSERT INTO instalacoes (cliente,equip,pedido,valor,mat,sinal,receber,mat_comprar,data,vend,obs,anexos,checks,criado_por_id,criado_por_nome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(d.cliente, d.equip, d.pedido, d.valor, d.mat, d.sinal, d.receber, d.matComprar, d.data, d.vend, d.obs, JSON.stringify(d.anexos || []), JSON.stringify(d.checks || {}), req.session.u.id, req.session.u.nome);
  audit(req, 'CRIAR_INSTALACAO', 'instalacoes', r.lastInsertRowid, null, { cliente: d.cliente, equip: d.equip });
  res.json({ sucesso: true, id: r.lastInsertRowid });
});
app.put('/api/instalacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,equip,valor,checks FROM instalacoes WHERE id=?').get(req.params.id);
  const d = req.body;
  db.prepare('UPDATE instalacoes SET cliente=?,equip=?,pedido=?,valor=?,mat=?,sinal=?,receber=?,mat_comprar=?,data=?,vend=?,obs=?,anexos=?,checks=? WHERE id=?')
    .run(d.cliente, d.equip, d.pedido, d.valor, d.mat, d.sinal, d.receber, d.matComprar, d.data, d.vend, d.obs, JSON.stringify(d.anexos || []), JSON.stringify(d.checks || {}), req.params.id);
  audit(req, 'EDITAR_INSTALACAO', 'instalacoes', req.params.id, antes ? { ...antes, checks: JSON.parse(antes.checks || '{}') } : null, { cliente: d.cliente, equip: d.equip });
  res.json({ sucesso: true });
});
app.delete('/api/instalacoes/:id', auth, (req, res) => {
  const antes = db.prepare('SELECT cliente,equip FROM instalacoes WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM instalacoes WHERE id=?').run(req.params.id);
  audit(req, 'EXCLUIR_INSTALACAO', 'instalacoes', req.params.id, antes, null);
  res.json({ sucesso: true });
});

// ── AUDITORIA ──
app.get('/api/auditoria', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM auditoria ORDER BY momento DESC LIMIT 1000').all());
});

app.listen(PORT, () => console.log('Capellato rodando na porta', PORT));
