import React, { useState, useEffect, useRef } from 'react';
import InstallView from './install';
import { 
  Upload, Award, Database, LogOut, CheckCircle, 
  Shield, Download, Settings, Server, Lock, QrCode, 
  User, Trash2, RotateCcw, Save, Menu, Globe, Key,
  FilePlus, Move, Check, X, AlertCircle, Edit, List,
  Layout, Eye, Play, CornerDownRight, BarChart, Plus,
  Search, ShieldCheck, UserPlus, Info, ExternalLink
} from 'lucide-react';

/**
 * ==========================================
 * 1. 核心翻译配置
 * ==========================================
 */
const TRANSLATIONS = {
  zh: {
    loading: "系统连接中...",
    loginTitle: "无线电奖项中心",
    callsign: "呼号",
    password: "密码",
    loginBtn: "登录",
    regBtn: "立即注册",
    tabUser: "普通用户登录",
    tabAdmin: "管理员 / 奖状管理",
    dashboard: "状态概览",
    publicAwards: "奖状大厅",
    myAwards: "已申领奖状",
    logbook: "日志管理",
    userCenter: "用户中心",
    awardAdmin: "奖状管理后台",
    sysAdmin: "系统管理后台",
    logout: "安全退出",
    createAward: "新建奖状",
    drafts: "草稿箱",
    users: "用户管理",
    security: "账号安全",
    totalQso: "上传日志总数",
    dxcc: "DXCC 统计",
    regTitle: "用户注册",
    backToLogin: "返回登录",
    thirdPartyLogin: "第三方登录 (预留接口)",
    changePass: "修改密码",
    enable2fa: "开启 2FA",
    clearLogs: "清空日志",
    delAccount: "注销账户"
  }
};

/**
 * ==========================================
 * 2. API 封装
 * ==========================================
 */
const apiFetch = async (endpoint, options = {}) => {
  const token = localStorage.getItem('ham_token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/api${endpoint}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
};

/**
 * ==========================================
 * 3. 业务功能组件 (模块化)
 * ==========================================
 */

// 概览模块
const DashboardView = ({ user, t }) => {
  const [stats, setStats] = useState({ qsos: 0, dxcc: 0 });
  useEffect(() => { apiFetch('/dashboard/stats').then(setStats).catch(console.error); }, []);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="text-slate-500 text-sm font-bold uppercase mb-1">{t.totalQso}</div>
          <div className="text-4xl font-black text-blue-600">{stats.qsos}</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="text-slate-500 text-sm font-bold uppercase mb-1">{t.dxcc}</div>
          <div className="text-4xl font-black text-purple-600">{stats.dxcc}</div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="text-slate-500 text-sm font-bold uppercase mb-1">当前身份</div>
          <div className="text-2xl font-black text-slate-800 uppercase">{user.role}</div>
        </div>
      </div>
    </div>
  );
};

// 系统管理模块
const SysAdminView = ({ t }) => (
  <div className="space-y-6">
    <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
      <div className="p-6 border-b bg-slate-50 flex justify-between items-center">
        <h3 className="font-bold flex items-center gap-2"><ShieldCheck className="text-blue-600"/> {t.users}</h3>
        <button className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2"><Plus size={16}/> 新增用户</button>
      </div>
      <div className="p-12 text-center text-slate-400">正在加载用户列表...</div>
    </div>
  </div>
);

// 奖状管理模块
const AwardAdminView = ({ t }) => (
  <div className="space-y-6">
    <div className="flex gap-4">
      <button className="flex-1 bg-white p-6 rounded-2xl shadow-sm border border-slate-100 hover:border-blue-500 transition-all text-left">
        <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center mb-4"><FilePlus size={24} /></div>
        <div className="font-bold text-lg">{t.createAward}</div>
        <p className="text-slate-400 text-sm">设计并发布新的无线电奖项</p>
      </button>
      <button className="flex-1 bg-white p-6 rounded-2xl shadow-sm border border-slate-100 hover:border-purple-500 transition-all text-left">
        <div className="w-12 h-12 bg-purple-50 text-purple-600 rounded-xl flex items-center justify-center mb-4"><List size={24} /></div>
        <div className="font-bold text-lg">{t.drafts}</div>
        <p className="text-slate-400 text-sm">继续编辑未完成的奖状草稿</p>
      </button>
    </div>
  </div>
);

// 用户中心模块
const UserCenterView = ({ user, t }) => (
  <div className="max-w-2xl space-y-6">
    <div className="bg-white p-8 rounded-2xl shadow-sm border">
      <h3 className="text-xl font-bold mb-6 flex items-center gap-2"><Settings className="text-blue-600"/> {t.security}</h3>
      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
          <div><div className="font-bold">{t.changePass}</div><div className="text-sm text-slate-400">定期更换密码</div></div>
          <button className="bg-white border px-4 py-2 rounded-lg text-sm font-bold">修改</button>
        </div>
        <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl">
          <div><div className="font-bold">{t.enable2fa}</div><div className="text-sm text-slate-400">启用双重验证</div></div>
          <button className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-bold">开启</button>
        </div>
      </div>
    </div>
  </div>
);

/**
 * ==========================================
 * 4. 主入口组件
 * ==========================================
 */
export default function App() {
  const [view, setView] = useState('loading'); // loading, login, register, install, main
  const [subView, setSubView] = useState('dashboard');
  const [user, setUser] = useState(null);
  const [sysStatus, setSysStatus] = useState(null);
  const [t] = useState(TRANSLATIONS.zh);
  const [loginTab, setLoginTab] = useState('user'); // user, admin
  const [error, setError] = useState('');

  // 检查系统状态与自动登录
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/system-status');
        const status = await res.json();
        setSysStatus(status);
        const token = localStorage.getItem('ham_token');
        const savedUser = localStorage.getItem('ham_user');
        
        if (!status.installed) setView('install');
        else if (token && savedUser) {
          const u = JSON.parse(savedUser);
          setUser(u);
          setView('main');
          // 根据角色设置初始视图
          if (u.role === 'admin') setSubView('sysAdmin');
          else if (u.role === 'award_admin') setSubView('awardAdmin');
          else setSubView('dashboard');
        } else setView('login');
      } catch (e) { setView('login'); }
    };
    check();
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('ham_token');
    localStorage.removeItem('ham_user');
    setUser(null);
    setView('login');
  };

  // 渲染逻辑
  if (view === 'loading') return <div className="h-screen flex items-center justify-center text-slate-400">{t.loading}</div>;
  if (view === 'install') return <InstallView t={t} onComplete={() => window.location.reload()} />;

  // 统一登录页
  if (view === 'login') return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="bg-blue-600 p-8 text-white text-center">
          <Award size={48} className="mx-auto mb-4" />
          <h1 className="text-2xl font-bold">{t.loginTitle}</h1>
        </div>
        <div className="flex border-b">
          <button onClick={() => setLoginTab('user')} className={`flex-1 py-4 text-sm font-bold ${loginTab === 'user' ? 'text-blue-600 border-b-2 border-blue-600 bg-blue-50' : 'text-gray-500'}`}>{t.tabUser}</button>
          <button onClick={() => setLoginTab('admin')} className={`flex-1 py-4 text-sm font-bold ${loginTab === 'admin' ? 'text-purple-600 border-b-2 border-purple-600 bg-purple-50' : 'text-gray-500'}`}>{t.tabAdmin}</button>
        </div>
        <form className="p-8 space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          const data = Object.fromEntries(new FormData(e.target));
          try {
            const res = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ ...data, loginType: loginTab }) });
            localStorage.setItem('ham_token', res.token);
            localStorage.setItem('ham_user', JSON.stringify(res.user));
            setUser(res.user);
            setView('main');
            if (res.user.role === 'admin') setSubView('sysAdmin');
            else if (res.user.role === 'award_admin') setSubView('awardAdmin');
            else setSubView('dashboard');
          } catch (err) { setError(err.message); }
        }}>
          {error && <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex items-center gap-2"><AlertCircle size={16} /> {error}</div>}
          <input name="callsign" required className="w-full border-2 border-gray-100 rounded-xl p-3" placeholder={t.callsign} />
          <input name="password" type="password" required className="w-full border-2 border-gray-100 rounded-xl p-3" placeholder={t.password} />
          <button type="submit" className={`w-full py-4 rounded-xl text-white font-bold ${loginTab === 'admin' ? 'bg-purple-600' : 'bg-blue-600'}`}>{t.loginBtn}</button>
          <button type="button" onClick={() => setView('register')} className="w-full text-blue-600 text-sm font-bold">{t.regBtn}</button>
        </form>
      </div>
    </div>
  );

  // 注册页
  if (view === 'register') return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
        <h2 className="text-2xl font-bold mb-6">{t.regTitle}</h2>
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(e.target));
          try {
            await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify(data) });
            alert('注册成功'); setView('login');
          } catch (err) { alert(err.message); }
        }}>
          <input name="callsign" required className="w-full border-2 border-gray-100 rounded-xl p-3" placeholder={t.callsign} />
          <input name="password" type="password" required className="w-full border-2 border-gray-100 rounded-xl p-3" placeholder={t.password} />
          <button className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold">{t.regBtn}</button>
          <button type="button" onClick={() => setView('login')} className="w-full text-gray-500 text-sm">{t.backToLogin}</button>
        </form>
      </div>
    </div>
  );

  // 主界面 (完全基于角色)
  if (view === 'main') {
    const navItems = [
      { id: 'dashboard', label: t.dashboard, icon: BarChart, roles: ['user', 'award_admin', 'admin'] },
      { id: 'publicAwards', label: t.publicAwards, icon: Globe, roles: ['user', 'award_admin', 'admin'] },
      { id: 'myAwards', label: t.myAwards, icon: Award, roles: ['user'] },
      { id: 'logbook', label: t.logbook, icon: Database, roles: ['user'] },
      { id: 'awardAdmin', label: t.awardAdmin, icon: Shield, roles: ['award_admin', 'admin'] },
      { id: 'sysAdmin', label: t.sysAdmin, icon: Settings, roles: ['admin'] },
      { id: 'userCenter', label: t.userCenter, icon: User, roles: ['user', 'award_admin', 'admin'] },
    ].filter(item => item.roles.includes(user.role));

    return (
      <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
        <aside className="w-full md:w-64 bg-slate-900 text-white flex flex-col">
          <div className="p-6 border-b border-slate-800 font-bold text-xl">HAM AWARDS</div>
          <nav className="flex-1 p-4 space-y-1">
            {navItems.map(item => (
              <button key={item.id} onClick={() => setSubView(item.id)} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg ${subView === item.id ? 'bg-blue-600' : 'text-slate-400 hover:bg-slate-800'}`}>
                <item.icon size={20} /><span className="font-medium">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="p-4 border-t border-slate-800">
            <button onClick={handleLogout} className="w-full flex items-center gap-3 px-4 py-3 text-red-400 hover:bg-red-900/20 rounded-lg transition-colors">
              <LogOut size={20} /><span>{t.logout}</span>
            </button>
          </div>
        </aside>
        <main className="flex-1 overflow-y-auto p-8">
          <div className="max-w-6xl mx-auto">
            {subView === 'dashboard' && <DashboardView user={user} t={t} />}
            {subView === 'sysAdmin' && <SysAdminView t={t} />}
            {subView === 'awardAdmin' && <AwardAdminView t={t} />}
            {subView === 'userCenter' && <UserCenterView user={user} t={t} />}
            {/* 其他模块占位 */}
            {!['dashboard', 'sysAdmin', 'awardAdmin', 'userCenter'].includes(subView) && (
              <div className="bg-white p-20 rounded-2xl shadow-sm text-center border-2 border-dashed border-slate-200 text-slate-400">模块开发中...</div>
            )}
          </div>
        </main>
      </div>
    );
  }

  return null;
}
