import express from 'express';
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
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));

// 配置上传
const upload = multer({ dest: 'uploads/' });

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
    jwtSecret: 'default_secret_change_on_install',
    adminPath: 'admin' 
};

/**
 * ==========================================
 * 1. 工具函数：ADIF 解析 & MinIO 初始化
 * ==========================================
 */
function parseAdif(adifString) {
  const records = [];
  const parts = adifString.split(/<eor>/i); 
  
  for (let part of parts) {
    if (!part.trim()) continue;
    const record = {};
    const regex = /<([a-zA-Z0-9_]+):(\d+)(?::[a-zA-Z])?>([^<]*)/g;
    let match;
    while ((match = regex.exec(part)) !== null) {
      const field = match[1].toLowerCase();
      const length = parseInt(match[2]);
      const data = match[3].substring(0, length);
      record[field] = data.trim();
    }
    if (record.call && record.qso_date) {
      records.push(record);
    }
  }
  return records;
}

async function initMinioBucket() {
    if (!minioClient || !appConfig.minioBucket) return;
    try {
        const exists = await minioClient.bucketExists(appConfig.minioBucket);
        if (!exists) {
            await minioClient.makeBucket(appConfig.minioBucket, 'us-east-1');
            console.log(`Bucket '${appConfig.minioBucket}' created successfully.`);
            // 设置策略为公开只读（简化图片访问）
            const policy = {
                Version: "2012-10-17",
                Statement: [{
                    Effect: "Allow",
                    Principal: { AWS: ["*"] },
                    Action: ["s3:GetObject"],
                    Resource: [`arn:aws:s3:::${appConfig.minioBucket}/*`]
                }]
            };
            await minioClient.setBucketPolicy(appConfig.minioBucket, JSON.stringify(policy));
        }
    } catch (err) {
        console.error("MinIO Bucket init error:", err);
    }
}

/**
 * ==========================================
 * 2. 系统初始化
 * ==========================================
 */
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      appConfig = { ...appConfig, ...data };
      
      if (appConfig.installed && appConfig.db) {
        dbPool = new Pool(appConfig.db);
        console.log("Database pool initialized.");
        upgradeSchema();
      }
      if (appConfig.minio && appConfig.minio.endPoint) {
        minioClient = new Minio.Client(appConfig.minio);
        console.log("MinIO client initialized.");
        initMinioBucket();
      }
    } catch (e) { 
      console.error("Config load error:", e);
      appConfig.installed = false;
    }
  } else {
    appConfig.installed = false;
  }
}

async function upgradeSchema() {
  if (!dbPool) return;
  const client = await dbPool.connect();
  try {
    // 基础用户表
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, 
        callsign VARCHAR(20) UNIQUE NOT NULL, 
        password_hash TEXT NOT NULL, 
        role VARCHAR(20) DEFAULT 'user', 
        totp_secret TEXT, 
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 健壮地检查并添加 last_seen 列 (修复 Issue 2 & 3)
    const checkCol = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='last_seen'");
    if (checkCol.rows.length === 0) {
        console.log("Adding missing column 'last_seen' to users table...");
        await client.query("ALTER TABLE users ADD COLUMN last_seen TIMESTAMP DEFAULT NOW()");
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS qsos (
        id SERIAL PRIMARY KEY, 
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        callsign VARCHAR(20),
        band VARCHAR(10),
        mode VARCHAR(10),
        dxcc VARCHAR(10),
        country VARCHAR(100),
        qso_date VARCHAR(20),
        adif_raw JSONB NOT NULL, 
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, callsign, band, mode, qso_date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS awards (
        id SERIAL PRIMARY KEY, 
        name TEXT NOT NULL, 
        description TEXT, 
        bg_url TEXT,
        rules JSONB DEFAULT '[]', 
        layout JSONB DEFAULT '[]', 
        status VARCHAR(20) DEFAULT 'draft',
        creator_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await client.query(`
        CREATE TABLE IF NOT EXISTS user_awards (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            award_id INTEGER REFERENCES awards(id) ON DELETE CASCADE,
            issued_at TIMESTAMP DEFAULT NOW()
        );
    `);

    console.log("Database schema checked.");
  } catch (err) {
    console.error("Schema upgrade error:", err.message);
  } finally {
    client.release();
  }
}

/**
 * ==========================================
 * 3. 中间件与权限
 * ==========================================
 */

const verifyToken = async (req, res, next) => {
  if (!appConfig.installed && req.path.startsWith('/api/install')) return next();
  if (req.path === '/api/system-status' || req.path === '/api/auth/login' || req.path === '/api/auth/register') return next(); 

  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'TOKEN_MISSING', message: '未提供验证令牌' });
  
  // 1. 先验证 Token (修复 Issue 1: 将 JWT 验证与数据库操作分离)
  let decoded;
  try {
    decoded = jwt.verify(token.split(' ')[1], appConfig.jwtSecret);
  } catch (err) { 
    return res.status(401).json({ error: 'TOKEN_INVALID', message: '无效或过期的令牌' }); 
  }

  req.user = decoded; 
  
  // 2. 异步更新在线状态，不阻塞请求，且单独捕获错误
  if (dbPool && req.user && req.user.id) {
      dbPool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [req.user.id])
          .catch(err => console.error("Update last_seen failed (non-critical):", err.message));
  }
  
  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'PERMISSION_DENIED', message: '需要系统管理员权限' });
  next();
};

const verifyAwardAdmin = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'award_admin') return res.status(403).json({ error: 'PERMISSION_DENIED', message: '需要奖状管理员权限' });
  next();
};

const require2FA = async (req, res, next) => {
    try {
        const result = await dbPool.query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
        const secret = result.rows[0]?.totp_secret;
        if (!secret) return next(); 

        const code = req.headers['x-2fa-code']; 
        if (!code) return res.status(403).json({ error: '2FA_REQUIRED', message: '此操作需要2FA验证' });
        
        if (!otplib.authenticator.check(code, secret)) {
            return res.status(403).json({ error: 'INVALID_2FA', message: '验证码错误' });
        }
        next();
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
};

// 验证密码中间件 (用于危险操作)
const requirePassword = async (req, res, next) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'PASSWORD_REQUIRED', message: '需要密码确认' });
    try {
        const r = await dbPool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
        const match = await bcrypt.compare(password, r.rows[0].password_hash);
        if (!match) return res.status(401).json({ error: 'PASSWORD_INVALID', message: '密码错误' });
        next();
    } catch(e) { res.status(500).json({ error: 'Server Error' }); }
};


/**
 * ==========================================
 * 4. API 路由
 * ==========================================
 */

// --- 基础 & 认证 ---

app.get('/api/system-status', (req, res) => {
    res.json({ 
        installed: appConfig.installed, 
        useHttps: appConfig.useHttps,
        adminPath: appConfig.adminPath || 'admin',
        minioConfigured: !!appConfig.minio
    });
});

app.post('/api/install', async (req, res) => {
  if (appConfig.installed) return res.status(400).json({ error: '系统已安装' });
  const { dbHost, dbPort, dbUser, dbPass, dbName, adminCall, adminPass, adminPath, minio, useHttps, minioBucket } = req.body;
  
  let tempPool = new Pool({ user: dbUser, host: dbHost, database: dbName, password: dbPass, port: dbPort });
  let client;

  try {
    client = await tempPool.connect();
    // 建表
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, callsign VARCHAR(20) UNIQUE NOT NULL, password_hash TEXT NOT NULL, role VARCHAR(20) DEFAULT 'user', totp_secret TEXT, created_at TIMESTAMP DEFAULT NOW(), last_seen TIMESTAMP DEFAULT NOW());
    `);
    
    // 管理员
    const hash = await bcrypt.hash(adminPass, 10);
    await client.query('DELETE FROM users WHERE callsign = $1', [adminCall.toUpperCase()]);
    await client.query(`INSERT INTO users (callsign, password_hash, role) VALUES ($1, $2, 'admin')`, [adminCall.toUpperCase(), hash]);

    const newConfig = { 
        installed: true, 
        jwtSecret: crypto.randomBytes(64).toString('hex'), 
        db: { user: dbUser, host: dbHost, database: dbName, password: dbPass, port: dbPort },
        minio: minio,
        minioBucket: minioBucket || 'ham-awards', // 保存 Bucket 名称
        useHttps: !!useHttps,
        adminPath: adminPath || 'admin'
    };
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    appConfig = newConfig; 
    dbPool = tempPool;
    
    if (appConfig.minio) {
        minioClient = new Minio.Client(appConfig.minio);
        await initMinioBucket(); // 立即初始化 Bucket
    }
    
    await upgradeSchema();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); } finally { if (client) client.release(); }
});

app.post('/api/auth/login', async (req, res) => {
    const { callsign, password, code, loginType } = req.body;
    try {
        const result = await dbPool.query(`SELECT * FROM users WHERE callsign = $1`, [callsign.toUpperCase()]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'AUTH_FAILED', message: '用户不存在' });
        const user = result.rows[0];

        const passMatch = await bcrypt.compare(password, user.password_hash);
        if (!passMatch) return res.status(401).json({ error: 'AUTH_FAILED', message: '密码错误' });

        if (loginType === 'admin' && user.role === 'user') {
            return res.status(403).json({ error: 'ACCESS_DENIED', message: '普通用户请使用普通登录入口' });
        }

        if (user.totp_secret) {
            if (!code) return res.status(403).json({ error: '2FA_REQUIRED', message: '请输入两步验证码' });
            if (!otplib.authenticator.check(code, user.totp_secret)) return res.status(403).json({ error: 'INVALID_2FA', message: '验证码无效' });
        }

        const token = jwt.sign({ id: user.id, role: user.role, callsign: user.callsign }, appConfig.jwtSecret, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, callsign: user.callsign, role: user.role, has2fa: !!user.totp_secret } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
});

app.post('/api/auth/register', async (req, res) => {
    const { callsign, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await dbPool.query(`INSERT INTO users (callsign, password_hash, role) VALUES ($1, $2, 'user')`, [callsign.toUpperCase(), hash]);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') res.status(400).json({ error: 'EXISTS', message: '呼号已被注册' });
        else res.status(500).json({ error: 'ERROR', message: e.message });
    }
});

// --- 统计概览 ---

app.get('/api/stats/dashboard', verifyToken, async (req, res) => {
    const { role, id } = req.user;
    const client = await dbPool.connect();
    
    try {
        let stats = {};

        if (role === 'user') {
            // 普通用户：QSO 统计, 奖状统计
            const qsoCount = await client.query('SELECT count(*) FROM qsos WHERE user_id=$1', [id]);
            const bandCount = await client.query('SELECT count(DISTINCT band) FROM qsos WHERE user_id=$1', [id]);
            const modeCount = await client.query('SELECT count(DISTINCT mode) FROM qsos WHERE user_id=$1', [id]);
            const dxccCount = await client.query('SELECT count(DISTINCT dxcc) FROM qsos WHERE user_id=$1', [id]);
            const awardCount = await client.query('SELECT count(*) FROM user_awards WHERE user_id=$1', [id]);

            stats = {
                qsos: qsoCount.rows[0].count,
                bands: bandCount.rows[0].count,
                modes: modeCount.rows[0].count,
                dxccs: dxccCount.rows[0].count,
                my_awards: awardCount.rows[0].count
            };
        } else if (role === 'award_admin') {
            // 奖状管理员：总奖状(已批准), 我的草稿, 审核中, 已批准
            const totalApproved = await client.query("SELECT count(*) FROM awards WHERE status = 'approved'");
            const myDrafts = await client.query("SELECT count(*) FROM awards WHERE creator_id=$1 AND status='draft'", [id]);
            const pending = await client.query("SELECT count(*) FROM awards WHERE status='pending'");
            
            stats = {
                total_approved: totalApproved.rows[0].count,
                my_drafts: myDrafts.rows[0].count,
                pending: pending.rows[0].count,
            };
        } else if (role === 'admin') {
            // 系统管理员：系统状态, 在线用户(role), 总用户(role), 奖状(active/pending/issued)
            // 在线用户定义：过去 5 分钟内有活动
            const onlineTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
            
            // 使用 try-catch 保护查询，防止因字段缺失导致整个面板崩溃
            let onlineUsers = { rows: [] };
            try {
                onlineUsers = await client.query(`
                    SELECT role, count(*) as count FROM users 
                    WHERE last_seen > $1 
                    GROUP BY role
                `, [onlineTime]);
            } catch (err) {
                console.error("Dashboard online users query failed:", err.message);
                // Fallback: 不显示在线状态，或者显示0
            }

            const totalUsers = await client.query('SELECT role, count(*) as count FROM users GROUP BY role');
            const totalAwards = await client.query("SELECT count(*) FROM awards WHERE status = 'approved'");
            const pendingAwards = await client.query("SELECT count(*) FROM awards WHERE status = 'pending'");
            const issuedAwards = await client.query("SELECT count(*) FROM user_awards");

            stats = {
                system_status: 'running',
                online_users: onlineUsers.rows, // [{role: 'user', count: 10}, ...]
                total_users: totalUsers.rows,
                awards_approved: totalAwards.rows[0].count,
                awards_pending: pendingAwards.rows[0].count,
                awards_issued: issuedAwards.rows[0].count
            };
        }
        res.json(stats);
    } catch (e) {
        console.error("Dashboard error:", e);
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});


// --- 用户中心 & 安全 ---

app.get('/api/user/profile', verifyToken, async (req, res) => {
    const r = await dbPool.query('SELECT id, callsign, role, totp_secret, created_at FROM users WHERE id=$1', [req.user.id]);
    const u = r.rows[0];
    res.json({ ...u, has2fa: !!u.totp_secret, totp_secret: undefined });
});

app.post('/api/user/2fa/setup', verifyToken, async (req, res) => {
    const secret = otplib.authenticator.generateSecret();
    const otpauth = otplib.authenticator.keyuri(req.user.callsign, 'HamAwards', secret);
    const imgData = await qrcode.toDataURL(otpauth);
    res.json({ secret, qr: imgData });
});

app.post('/api/user/2fa/enable', verifyToken, async (req, res) => {
    const { secret, token } = req.body;
    if (otplib.authenticator.check(token, secret)) {
        await dbPool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, req.user.id]);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: '验证码无效' });
    }
});

app.post('/api/user/2fa/disable', verifyToken, async (req, res) => {
    const { password } = req.body;
    const client = await dbPool.connect();
    try {
        const r = await client.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
        const match = await bcrypt.compare(password, r.rows[0].password_hash);
        if(!match) return res.status(401).json({error: '密码错误'});
        await client.query('UPDATE users SET totp_secret=NULL WHERE id=$1', [req.user.id]);
        res.json({ success: true });
    } finally { client.release(); }
});

app.post('/api/user/password', verifyToken, require2FA, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const client = await dbPool.connect();
    try {
        const r = await client.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
        const match = await bcrypt.compare(oldPassword, r.rows[0].password_hash);
        if(!match) return res.status(401).json({error: '旧密码错误'});
        const hash = await bcrypt.hash(newPassword, 10);
        await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
        res.json({ success: true });
    } finally { client.release(); }
});

// 清空日志 (危险操作)
app.delete('/api/user/logs', verifyToken, requirePassword, require2FA, async (req, res) => {
    await dbPool.query('DELETE FROM qsos WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
});

// 注销账号 (危险操作)
app.delete('/api/user/account', verifyToken, requirePassword, require2FA, async (req, res) => {
    await dbPool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    res.json({ success: true });
});


// --- 日志系统 ---

app.post('/api/logbook/upload', verifyToken, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        const raw = fs.readFileSync(req.file.path, 'utf8');
        const records = parseAdif(raw);
        let imported = 0;
        const client = await dbPool.connect();
        try {
            await client.query('BEGIN');
            for (let r of records) {
                await client.query(`
                    INSERT INTO qsos (user_id, callsign, band, mode, qso_date, dxcc, country, adif_raw)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (user_id, callsign, band, mode, qso_date) DO NOTHING
                `, [req.user.id, r.call || '', r.band || '', r.mode || '', r.qso_date || '', r.dxcc || '', r.country || '', JSON.stringify(r)]);
                imported++;
            }
            await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); fs.unlinkSync(req.file.path); }
        res.json({ success: true, count: records.length, imported });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 奖状管理 ---

app.post('/api/awards', verifyToken, verifyAwardAdmin, async (req, res) => {
    const { id, name, description, rules, layout, bg_url, status } = req.body;
    const targetStatus = status === 'approved' && req.user.role !== 'admin' ? 'pending' : status;
    const sqlParams = [name, description, JSON.stringify(rules), JSON.stringify(layout), bg_url, targetStatus];
    
    if (id) {
        await dbPool.query(`UPDATE awards SET name=$1, description=$2, rules=$3, layout=$4, bg_url=$5, status=$6 WHERE id=$7`, [...sqlParams, id]);
        res.json({ success: true, id });
    } else {
        const r = await dbPool.query(`INSERT INTO awards (name, description, rules, layout, bg_url, status, creator_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [...sqlParams, req.user.id]);
        res.json({ success: true, id: r.rows[0].id });
    }
});

app.post('/api/awards/upload-bg', verifyToken, verifyAwardAdmin, upload.single('bg'), async (req, res) => {
    if (!req.file || !minioClient) return res.status(400).json({ error: 'Upload failed or MinIO not configured' });
    const meta = { 'Content-Type': req.file.mimetype };
    const fileName = `awards/bg_${Date.now()}_${req.file.originalname}`;
    try {
        await minioClient.putObject(appConfig.minioBucket, fileName, fs.createReadStream(req.file.path), meta);
        const protocol = appConfig.minio.useSSL ? 'https://' : 'http://';
        const fullUrl = `${protocol}${appConfig.minio.endPoint}:${appConfig.minio.port}/${appConfig.minioBucket}/${fileName}`;
        fs.unlinkSync(req.file.path);
        res.json({ url: fullUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/awards', verifyToken, async (req, res) => {
    let sql = `SELECT * FROM awards WHERE status = 'approved'`;
    if (req.user.role === 'admin' || req.user.role === 'award_admin') {
        sql = `SELECT * FROM awards`;
    }
    const r = await dbPool.query(sql + ` ORDER BY id DESC`);
    res.json(r.rows);
});

// --- 系统管理 ---

app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    const r = await dbPool.query('SELECT id, callsign, role, created_at, totp_secret IS NOT NULL as has_2fa FROM users ORDER BY id');
    res.json(r.rows);
});

// 添加用户
app.post('/api/admin/users', verifyToken, verifyAdmin, require2FA, async (req, res) => {
    const { callsign, password, role } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        await dbPool.query(`INSERT INTO users (callsign, password_hash, role) VALUES ($1, $2, $3)`, [callsign.toUpperCase(), hash, role || 'user']);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') res.status(400).json({ error: 'EXISTS', message: '呼号已存在' });
        else res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/users/:id', verifyToken, verifyAdmin, require2FA, async (req, res) => {
    const { role, password } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    if (role) { updates.push(`role=$${idx++}`); values.push(role); }
    if (password) { const hash = await bcrypt.hash(password, 10); updates.push(`password_hash=$${idx++}`); values.push(hash); }
    values.push(req.params.id);
    await dbPool.query(`UPDATE users SET ${updates.join(',')} WHERE id=$${idx}`, values);
    res.json({ success: true });
});

app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, require2FA, async (req, res) => {
    await dbPool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
});

app.post('/api/admin/settings', verifyToken, verifyAdmin, require2FA, async (req, res) => {
    const { useHttps, adminPath } = req.body;
    appConfig.useHttps = useHttps;
    appConfig.adminPath = adminPath;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(appConfig, null, 2));
    res.json({ success: true });
});

// 启动
loadConfig();
const PORT = 3003;
http.createServer(app).listen(PORT, () => console.log(`Server running on port ${PORT}`));