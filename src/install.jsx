import React, { useState } from 'react';
import { Server, Database, Lock, User, Shield, HardDrive, Globe, CheckCircle } from 'lucide-react';

/**
 * InstallView - 系统初始化安装界面
 * 负责收集数据库、管理员账户、MinIO 存储及安全配置
 */
export default function InstallView({ onComplete, t }) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState({
    dbHost: 'localhost',
    dbPort: '5432',
    dbUser: '',
    dbPass: '',
    dbName: 'ham_awards',
    adminCall: '',
    adminPass: '',
    minioEndpoint: '',
    minioPort: '9000',
    minioAccessKey: '',
    minioSecretKey: '',
    minioBucket: 'ham-awards',
    useHttps: false
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setConfig(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          minio: config.minioEndpoint ? {
            endPoint: config.minioEndpoint,
            port: parseInt(config.minioPort),
            useSSL: config.useHttps,
            accessKey: config.minioAccessKey,
            secretKey: config.minioSecretKey
          } : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '安装失败');
      alert('安装成功！系统将重新加载。');
      onComplete();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden">
        <div className="bg-slate-900 p-8 text-white">
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Server className="text-blue-500" /> {t.installTitle}
          </h1>
          <p className="text-slate-400 text-sm mt-2">欢迎使用 Ham Awards 系统,请按照指引完成初始化配置。</p>
          
          {/* 进度条 */}
          <div className="flex gap-2 mt-8">
            {[1, 2, 3].map(i => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${step >= i ? 'bg-blue-500' : 'bg-slate-700'}`}></div>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-8">
          {step === 1 && (
            <div className="space-y-6">
              <h3 className="font-bold text-lg flex items-center gap-2"><Database className="text-blue-600"/> 数据库配置 (PostgreSQL)</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">主机地址</label>
                  <input name="dbHost" value={config.dbHost} onChange={handleChange} required className="w-full border rounded-lg p-3" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">端口</label>
                  <input name="dbPort" value={config.dbPort} onChange={handleChange} required className="w-full border rounded-lg p-3" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">用户名</label>
                  <input name="dbUser" value={config.dbUser} onChange={handleChange} required className="w-full border rounded-lg p-3" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">密码</label>
                  <input name="dbPass" type="password" value={config.dbPass} onChange={handleChange} required className="w-full border rounded-lg p-3" />
                </div>
                <div className="col-span-2 space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">数据库名称</label>
                  <input name="dbName" value={config.dbName} onChange={handleChange} required className="w-full border rounded-lg p-3" />
                </div>
              </div>
              <button type="button" onClick={() => setStep(2)} className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold">下一步</button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <h3 className="font-bold text-lg flex items-center gap-2"><HardDrive className="text-orange-600"/> MinIO 存储服务配置 (可选)</h3>
              <p className="text-xs text-slate-400">用于存储奖状背景图及相关图片元素。若暂不配置可留空。</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">Endpoint (如: s3.example.com)</label>
                  <input name="minioEndpoint" value={config.minioEndpoint} onChange={handleChange} className="w-full border rounded-lg p-3" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">Access Key</label>
                  <input name="minioAccessKey" value={config.minioAccessKey} onChange={handleChange} className="w-full border rounded-lg p-3" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">Secret Key</label>
                  <input name="minioSecretKey" type="password" value={config.minioSecretKey} onChange={handleChange} className="w-full border rounded-lg p-3" />
                </div>
              </div>
              <div className="flex gap-4">
                <button type="button" onClick={() => setStep(1)} className="flex-1 bg-slate-100 text-slate-600 py-4 rounded-xl font-bold">上一步</button>
                <button type="button" onClick={() => setStep(3)} className="flex-1 bg-slate-900 text-white py-4 rounded-xl font-bold">下一步</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <h3 className="font-bold text-lg flex items-center gap-2"><Shield className="text-red-600"/> 系统管理员设置</h3>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">管理员呼号</label>
                  <input name="adminCall" value={config.adminCall} onChange={handleChange} required className="w-full border rounded-lg p-3" placeholder="e.g. BH4XXX" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-500 uppercase">管理员密码</label>
                  <input name="adminPass" type="password" value={config.adminPass} onChange={handleChange} required className="w-full border rounded-lg p-3" />
                </div>
                <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-xl">
                  <input type="checkbox" name="useHttps" checked={config.useHttps} onChange={handleChange} className="w-5 h-5 accent-blue-600" />
                  <div>
                    <div className="text-sm font-bold text-blue-800">启用 HTTPS 安全传输</div>
                    <div className="text-xs text-blue-600">建议在生产环境下开启</div>
                  </div>
                </div>
              </div>
              <div className="flex gap-4">
                <button type="button" onClick={() => setStep(2)} className="flex-1 bg-slate-100 text-slate-600 py-4 rounded-xl font-bold">上一步</button>
                <button type="submit" disabled={loading} className="flex-1 bg-blue-600 text-white py-4 rounded-xl font-bold shadow-lg shadow-blue-100">
                  {loading ? '正在安装...' : '完成安装'}
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
