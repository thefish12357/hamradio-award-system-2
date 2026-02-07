import express from 'express';
import https from 'https';
import http from 'http';
import pg from 'pg';
const { Pool } = pg;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import otplib from 'otplib';
import qrcode from 'qrcode';
import cors from 'cors';
import * as Minio from 'minio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

const CONFIG_FILE = path.join(__dirname, 'config.json');

// 2FA 配置
otplib.authenticator.options = { window: 1 };

let dbPool = null;
let minioClient = null;
let appConfig = { 
    installed: false, 
    useHttps: false,
    minio: null,
    minioBucket: 'ham-awards',
    jwtSecret: 'default_secret_change_on_install'
};

/**
 * ==========================================
 * 1. 系统初始化与配置加载
 * ==========================================
 */

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // 自动合并配置
      appConfig = { ...appConfig, ...data };
      
      if (appConfig.installed && appConfig.db) {
        dbPool = new Pool(appConfig.db);
        console.log("Database pool initialized.");
        upgradeSchema();
      }
      if (appConfig.minio) {
        minioClient = new Minio.Client(appConfig.minio);
        console.log("MinIO client initialized.");
      }
    } catch (e) { 
      console.error("Config load error:", e);
      appConfig.installed = false; // 加载失败视为未安装
    }
  } else {
    console.log("No config file found. System waiting for initialization.");
    appConfig.installed = false;
  }
}

async function upgradeSchema() {
  if (!dbPool) return;
  const client = await dbPool.connect();
  try {
    // 核心表结构定义
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, 
        callsign VARCHAR(20) UNIQUE NOT NULL, 
        password_hash TEXT NOT NULL, 
        role VARCHAR(20) DEFAULT 'user', 
        totp_secret TEXT, 
        language VARCHAR(5) DEFAULT 'zh', 
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS qsos (
        id SERIAL PRIMARY KEY, 
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        adif_data JSONB NOT NULL, 
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS awards (
        id SERIAL PRIMARY KEY, 
        name TEXT NOT NULL, 
        description TEXT, 
        rules JSONB, 
        layout JSONB, 
        bg_path TEXT, 
        status VARCHAR(20) DEFAULT 'approved',
        creator_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("Database schema is up to date.");
  } catch (err) {
    console.error("Schema upgrade error:", err.message);
  } finally {
    client.release();
  }
}

/**
 * ==========================================
 * 2. 核心中间件 - 权限控制
 * ==========================================
 */

const verifyToken = (req, res, next) => {
  // 系统未安装拦截
  if (!appConfig.installed) {
    if (req.path === '/api/install' || req.path === '/api/system-status') return next();
    return res.status(403).json({ error: 'SYSTEM_NOT_INSTALLED', message: '系统尚未初始化' });
  }

  // 免登录接口
  if (req.path === '/api/system-status' || req.path === '/api/install' || req.path === '/api/auth/login' || req.path === '/api/auth/register') return next(); 

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: '未提供验证令牌' });
  
  try {
    const decoded = jwt.verify(token.split(' ')[1], appConfig.jwtSecret);
    req.user = decoded; 
    next();
  } catch (err) { res.status(401).json({ error: '无效或过期的令牌' }); }
};

// 系统管理员权限校验
const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要系统管理员权限' });
  next();
};

// 奖状管理员权限校验 (系统管理员亦可)
const verifyAwardAdmin = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'award_admin') return res.status(403).json({ error: '需要奖状管理员权限' });
  next();
};

// 敏感操作 2FA 校验
const verifySensitiveAction = async (req, res, next) => {
    try {
      const result = await dbPool.query(`SELECT totp_secret FROM users WHERE id = $1`, [req.user.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
      const user = result.rows[0];
      if (!user.totp_secret) return next();
  
      const code = req.headers['x-2fa-code'];
      if (!code || !otplib.authenticator.check(code, user.totp_secret)) {
        return res.status(403).json({ error: 'INVALID_2FA', message: '动态验证码错误' });
      }
      next();
    } catch (err) { res.status(500).json({ error: '安全检查失败' }); }
};

/**
 * ==========================================
 * 3. API 路由定义
 * ==========================================
 */

// 3.1 基础与认证
app.get('/api/system-status', (req, res) => {
    res.json({ 
        installed: appConfig.installed, 
        useHttps: appConfig.useHttps,
        minio: !!appConfig.minio 
    });
});

app.post('/api/install', async (req, res) => {
  if (appConfig.installed) return res.status(400).json({ error: '系统已安装' });
  const { dbHost, dbPort, dbUser, dbPass, dbName, adminCall, adminPass, minio, useHttps } = req.body;
  
  let tempPool = new Pool({ user: dbUser, host: dbHost, database: dbName, password: dbPass, port: dbPort });
  let client = null;

  try {
    client = await tempPool.connect();
    // 初始化数据库表
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, callsign VARCHAR(20) UNIQUE NOT NULL, password_hash TEXT NOT NULL, 
        role VARCHAR(20) DEFAULT 'user', totp_secret TEXT, language VARCHAR(5) DEFAULT 'zh', 
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS qsos (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        adif_data JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS awards (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, 
        rules JSONB, layout JSONB, bg_path TEXT, status VARCHAR(20) DEFAULT 'approved',
        creator_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 写入初始管理员
    const hash = await bcrypt.hash(adminPass, 10);
    await client.query(`INSERT INTO users (callsign, password_hash, role) VALUES ($1, $2, 'admin')`, [adminCall.toUpperCase(), hash]);

    const newConfig = { 
        installed: true, 
        jwtSecret: crypto.randomBytes(64).toString('hex'), 
        db: { user: dbUser, host: dbHost, database: dbName, password: dbPass, port: dbPort },
        minio: minio,
        useHttps: !!useHttps
    };
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    appConfig = newConfig;
    dbPool = tempPool;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); } finally { if (client) client.release(); }
});

app.post('/api/auth/login', async (req, res) => {
    const { callsign, password, token, code, loginType } = req.body;
    try {
      const result = await dbPool.query(`SELECT * FROM users WHERE callsign = $1`, [callsign.toUpperCase()]);
      if (result.rows.length === 0) return res.status(401).json({ error: '用户不存在' });
      const user = result.rows[0];
      
      const passMatch = await bcrypt.compare(password, user.password_hash);
      if (!passMatch) return res.status(401).json({ error: '密码错误' });
  
      // 登录标签页权限预校验
      if (loginType === 'admin' && user.role === 'user') return res.status(403).json({ error: '权限不足: 请从普通用户入口登录' });
      if (loginType === 'user' && user.role !== 'user') return res.status(403).json({ error: '权限提示: 管理人员请从管理员入口登录' });

      // 2FA 校验
      if (user.totp_secret) {
        const twoFaCode = token || code;
        if (!twoFaCode || !otplib.authenticator.check(twoFaCode, user.totp_secret)) return res.status(403).json({ error: '动态验证码错误' });
      }
  
      const jwtToken = jwt.sign({ id: user.id, role: user.role, callsign: user.callsign }, appConfig.jwtSecret, { expiresIn: '24h' });
      res.json({ token: jwtToken, user: { id: user.id, callsign: user.callsign, role: user.role, has2fa: !!user.totp_secret } });
    } catch (err) { res.status(500).json({ error: '服务器内部错误' }); }
});

app.post('/api/auth/register', async (req, res) => {
    const { callsign, password } = req.body;
    try {
      const hash = await bcrypt.hash(password, 10);
      const result = await dbPool.query(`INSERT INTO users (callsign, password_hash, role) VALUES ($1, $2, 'user') RETURNING id, callsign, role`, [callsign.toUpperCase(), hash]);
      res.json(result.rows[0]);
    } catch (err) { res.status(400).json({ error: '该呼号已被注册' }); }
});

// 3.2 业务逻辑 (均受 verifyToken 保护)
app.get('/api/dashboard/stats', verifyToken, async (req, res) => {
    try {
        const resQso = await dbPool.query('SELECT count(*) FROM qsos WHERE user_id = $1', [req.user.id]);
        const resDxcc = await dbPool.query(`SELECT COUNT(DISTINCT adif_data->>'dxcc') FROM qsos WHERE user_id = $1 AND (adif_data->>'qsl_rcvd' IN ('Y','y') OR adif_data->>'lotw_qsl_rcvd' IN ('Y','y'))`, [req.user.id]);
        res.json({ qsos: resQso.rows[0].count, dxcc: resDxcc.rows[0].count });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/awards/public', verifyToken, async (req, res) => {
    try {
        const awards = await dbPool.query(`SELECT * FROM awards WHERE status = 'approved' ORDER BY id`);
        res.json(awards.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await dbPool.query(`SELECT id, callsign, role, created_at FROM users ORDER BY id`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * ==========================================
 * 4. 服务器启动
 * ==========================================
 */

function startServer() {
  const PORT = process.env.PORT || 3003;
  http.createServer(app).listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

loadConfig();
startServer();

// 所有未匹配路由返回前端单页应用
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
